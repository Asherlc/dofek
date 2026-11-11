# Agent Guidelines for @dofek/telemetry

Read [README.md](./README.md) first for the package's scope and usage.

- Keep destination-specific mapping at the exporter boundary so unrelated
  destinations receive the original record.
- Copy every field in the standard
  [ReadableLogRecord interface](https://open-telemetry.github.io/opentelemetry-js/interfaces/_opentelemetry_sdk-node.logs.ReadableLogRecord.html).
  Do not rely on object spread to preserve SDK record accessors.
- Exercise mapping through real SDK emission and verify repeated wrapping
  keeps one `custom` map.
