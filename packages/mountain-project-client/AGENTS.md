# Mountain Project Client Agent Guide

> Read [README.md](./README.md) first for the public contract and observed API behavior.

- The only supported endpoint is the public `tick-export` CSV endpoint.
- Do not add session login, API-key, upload, or route-enrichment behavior without an approved product requirement.
- Treat the profile ID as user-owned connection data even though the public export does not need authentication.
