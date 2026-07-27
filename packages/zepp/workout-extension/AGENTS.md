# Zepp Workout Extension Agent Guide

Read [README.md](./README.md) first, then read the parent
[`../README.md`](../README.md) for the companion app and shared ingest path.

## Boundaries

- This directory builds an independently submitted Zepp Workout Extension; do
  not merge its manifest, version, or app ID into the parent watch app.
- `data-widget/` runs inside the system Workout app. Keep it within the Zepp
  Workout Extension lifecycle and API surface.
- `setting/` stores server/email configuration and emits the one-shot password
  login command.
- `../app-side/index.ts` performs authentication and owns credentials plus
  connection state.
- `data-widget/` owns live sample buffering, pending batches, and upload
  behavior.
- Keep live metric names, units, timestamps, and server payloads aligned with
  the Zos ingestion contract in the root provider.
- Use the local build wrapper and generated manifest path; do not commit
  generated release artifacts.

## Tests

- `build.test.ts` covers manifest/build assembly.
- `setting/index.test.ts` covers settings and login behavior.
- `../src/workout-extension-data-widget.test.ts` covers the data widget's
  collection, buffering, and upload lifecycle.
- Run validation from `packages/zepp` so the parent toolchain and pinned Zepp
  dependencies are used.

Zepp's official lifecycle and submission constraints are linked from
[README.md](./README.md).
