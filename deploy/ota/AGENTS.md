# OTA image agent guidance

Read [README.md](README.md) and the parent [deployment README](../README.md)
before work here. Parent agent instructions also apply.

Keep the upstream patch limited to the reproduced storage-error, multipart-header,
Expo robot-authentication and [unchanged-publish receipt](https://github.com/mercuretechnologies/xprem/pull/312)
failures and their executable HTTP tests. Stateless publishing
must compare nonempty Expo actor IDs against the app's configured credential; a human
username is not required for [Expo robot tokens](https://docs.expo.dev/accounts/programmatic-access/).
Verify it applies to the exact source revision before
building. Use the canonical workflows for production changes; keep the historical buckets untouched and use the serving bucket documented
in the README.
