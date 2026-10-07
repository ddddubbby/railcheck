# Contributing

Use Node.js 22 or later. Run `npm test` and `npm run build` before submitting a change.

Keep user-entered amounts and address answers in memory only. Do not add analytics, wallet connections, third-party page resources, browser persistence, or input-bearing network requests. Do not log amounts. Data collection belongs in the offline repository job, never in the visitor's browser.

Treat changes to scoring, fee rules, event decoding and the pool format as behavioral changes. Add regression tests with independent expected results. Preserve privacy and accessible keyboard behavior. Use plain, conditional language for deposit matches.

Public pool files contain only amounts and times. Reader tests may contain public event fixtures; never add wallet secrets or private user examples.

Do not commit `.env`, RPC keys, deploy hook URLs, generated `dist/`, or dependencies. The source ZIP uses a fixed allowlist and must not expose secret files.
