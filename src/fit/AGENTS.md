# FIT Agent Guide

> **Read the [README.md](./README.md) first** for the core architecture and features.

## Agent-Specific Information

### Development Rules
- **Unit Safety**: Always ensure units are converted to the project's standard (m/s, meters, Celsius) during parsing.
- **Robustness**: Always use `parseFitFile` (which has a timeout) rather than the raw library call.
- **Data Integrity**: Ensure the `raw` field is populated in parsed records to allow for future extraction of additional fields.

### Testing Strategy
- **Fixture Tests**: `parser.test.ts` uses real-world FIT files from `fixtures/` to verify parsing accuracy.
- **Edge Cases**: `parser-edge.test.ts` handles corrupt files, missing fields, and non-standard FIT messages.
- **Regression**: When adding support for a new FIT field, add a corresponding fixture and test case.
