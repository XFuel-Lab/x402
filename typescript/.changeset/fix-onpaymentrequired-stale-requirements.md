---
"@x402/fetch": patch
"@x402/axios": patch
---

Fixed Fetch and Axios clients building payment payloads from the first 402 after an onPaymentRequired hook retry returned updated requirements.
