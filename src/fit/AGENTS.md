# FIT Agent Guide

> **Read the [README.md](./README.md) first** for the core architecture and features.

## Agent-Specific Information

### Development Rules
- **Unit Safety**: Always ensure units are converted to the project's standard (m/s, meters, Celsius) during parsing.
- **Bounded decoding**: Decode through `streamFitFile` or `streamFitBuffer`; never materialize a complete activity or remove the per-batch acknowledgement. The native decoder uses Garmin's official [FIT C++ SDK](https://github.com/garmin/fit-cpp-sdk).
- **Canonical persistence**: Providers that download FIT data must call `enqueueFitFileImportAndWait`; only the `fit-file-import` job should decode and persist FIT records. File-import jobs use `streamFitFile` so raw input bytes are not duplicated in JavaScript memory.
- **Data Integrity**: Ensure the `raw` field is populated in parsed records to allow for future extraction of additional fields.

### Testing Strategy
- **Native protocol**: The CTest in `native/fit-decoder` exercises the real decoder and enforces the 250-message batch limit.
- **Adapter tests**: `stream-decoder.test.ts` verifies Garmin profile names, acknowledgement backpressure, protocol ordering, failures, and idle-process cleanup.
- **Normalization tests**: `parser.test.ts` and `records.test.ts` cover pure decoded-field normalization and metric-row conversion.
- **Regression**: When adding support for a new FIT field, add a corresponding fixture and test case.
