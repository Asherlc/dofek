# OTA image agent guidance

Read [README.md](README.md) and the parent [deployment README](../README.md)
before work here. Parent agent instructions also apply.

Keep the upstream patch limited to the reproduced storage-error behavior and
its executable tests. Verify it applies to the exact source revision before
building. Use the canonical workflows for production changes; keep the historical buckets untouched and use the serving bucket documented
in the README.
