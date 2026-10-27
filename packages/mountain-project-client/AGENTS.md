# Mountain Project Client Agent Guide

> Read [README.md](./README.md) first for the public contract and observed API behavior.

- Supported read endpoints are the public [tick export](https://www.mountainproject.com/user/200232920/cole-schmidt/tick-export), [route JSON](https://www.mountainproject.com/api/v2/routes/105734660), and [Area JSON](https://www.mountainproject.com/api/v2/areas/105734057).
- Keep route-parent coordinates on the Area owner. Preserve the observed [root Area](https://www.mountainproject.com/api/v2/areas/105708959) parent-ID-0 sentinel without fetching it.
- Do not add session login, API-key, upload, or additional endpoint behavior without an approved product requirement.
- Treat the profile ID as user-owned connection data even though the public export does not need authentication.
