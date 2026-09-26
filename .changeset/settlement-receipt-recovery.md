---
"@jpyc-x402/shared": minor
"@jpyc-x402/evm": patch
---

Accept an optional 1–120 second receipt wait budget on settlement requests and retain the transaction hash when confirmation remains pending. Existing requests keep their 120 second receipt wait. Require more than 30 seconds of authorization lifetime before Ethereum/Sepolia submission and 15 seconds on other chains; this does not change the on-chain deadline or request a fresh signature.
