# Contributing

Contributions are welcome.

```bash
npm install
npm test
```

Please keep the default server read-only. Any proposal to expose an Aircall write endpoint should be discussed in an issue and, if accepted, implemented as a separate explicit opt-in surface rather than added to the default toolset.

Tests must not call a live Aircall account or contain credentials, call data, transcripts, phone numbers, or other personal information.
