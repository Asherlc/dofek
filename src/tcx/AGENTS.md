# TCX Agent Guide

> **Read the [README.md](./README.md) first** for the core architecture and features.

## Agent-Specific Information

### Development Rules
- **Streaming First**: Always use `sax` or a similar streaming parser for TCX to maintain efficiency.
- **Data Mapping**: Ensure new TCX extensions are correctly mapped in `ontext`.

### Testing Strategy
- **Unit Tests**: `parser.test.ts` for verifying that all standard TCX tags are correctly extracted and converted.
- **Mocking**: Use standard XML fixtures for testing different TCX variants (e.g., from Garmin, Strava).
