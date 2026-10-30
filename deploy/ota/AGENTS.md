# OTA image agent guidance

Read [README.md](README.md) and the parent [deployment README](../README.md)
before work here. Parent agent instructions also apply.

Keep [upstream.patch](upstream.patch) limited to the reproduced storage-error
and multipart `Content-Type` faults and their executable tests. The header
correction follows [Expo's multipart protocol](https://docs.expo.dev/technical-specs/expo-updates-1/#multipart-response)
and [MIME's entity-header grammar](https://www.rfc-editor.org/rfc/rfc2045.html#section-3).
Verify the patch applies to the exact source revision before building. Use the
canonical workflows for production changes; keep the historical buckets
untouched and use the serving bucket documented in the README.
