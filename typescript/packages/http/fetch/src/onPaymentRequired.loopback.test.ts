import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { wrapFetchWithPayment, x402Client, x402HTTPClient } from "./index";

const NETWORK = "eip155:84532";
const ASSET = "0x0000000000000000000000000000000000000001";
const PAY_TO = "0x0000000000000000000000000000000000000002";

const baseRequirements = {
  scheme: "exact",
  network: NETWORK,
  amount: "2",
  asset: ASSET,
  payTo: PAY_TO,
  maxTimeoutSeconds: 60,
  extra: {},
};

/**
 * Loopback server from the #3582 reproduction.
 * The first unpaid challenge for a URL advertises amount "1"; later challenges advertise "2".
 * A payment is accepted only when the decoded payment-signature uses amount "2".
 *
 * @param calls - Request counts keyed by URL
 * @returns HTTP server
 */
function createRequirementsServer(calls: Map<string, number>): Server {
  return createServer((req, res) => {
    req.resume();
    const url = req.url ?? "/";
    const count = (calls.get(url) ?? 0) + 1;
    calls.set(url, count);

    const paymentHeader = req.headers["payment-signature"];
    const payment = Array.isArray(paymentHeader) ? paymentHeader[0] : paymentHeader;
    if (payment) {
      const payload = JSON.parse(Buffer.from(payment, "base64").toString()) as {
        accepted: { amount: string };
      };
      if (payload.accepted.amount === "2") {
        res.writeHead(200);
        res.end("accepted current requirements");
        return;
      }
    }

    // The first offer is replaced by an updated offer on the hook retry.
    const amount = url.endsWith("/control") || count > 1 ? "2" : "1";
    const declaration = {
      x402Version: 2,
      resource: { url: `http://${req.headers.host}${url}` },
      accepts: [{ ...baseRequirements, amount }],
    };
    res.writeHead(402, {
      "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(declaration)).toString("base64"),
    });
    res.end("{}");
  });
}

describe("onPaymentRequired hook retry (#3582)", () => {
  const calls = new Map<string, number>();
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createRequirementsServer(calls);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve())),
    );
  });

  it.each(["control", "hook"] as const)(
    "pays amount 2 for wrapFetchWithPayment %s mode",
    async mode => {
      const createdAmounts: string[] = [];
      const client = new x402Client().register(NETWORK, {
        scheme: "exact",
        createPaymentPayload: async (x402Version, selected) => {
          createdAmounts.push(selected.amount);
          return { x402Version, payload: { testOnly: true } };
        },
      });
      client.setSpendControls({
        allowedAssets: [{ network: NETWORK, asset: ASSET, maxAmountPerPayment: "2" }],
      });
      const httpClient = new x402HTTPClient(client);
      if (mode === "hook") {
        httpClient.onPaymentRequired(async () => ({ headers: { "X-Test-Hook": "retry" } }));
      }

      const response = await wrapFetchWithPayment(fetch, httpClient)(`${base}/fetch/${mode}`);
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(text).toBe("accepted current requirements");
      expect(createdAmounts).toEqual(["2"]);
    },
  );
});
