# Analytics agent guidance

Read [README.md](README.md) first.

- Keep reusable numerical algorithms in
  [`packages/cycling-power`](../../packages/cycling-power/README.md); application
  policy, source selection, and persistence belong here.
- Preserve the single serialized projection writer and the processing-success
  gate in [`run-analytics-build.ts`](../../scripts/run-analytics-build.ts).
- Test source/version joins and projection lifecycle against ClickHouse using
  [`cycling-power-projector.integration.test.ts`](cycling-power-projector.integration.test.ts).
  SQL-string assertions cannot verify these database semantics.
