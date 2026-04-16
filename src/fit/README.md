# FIT Parser

This directory contains logic for parsing ANT+/Garmin FIT files.

## Core Features

- **Binary Parsing**: Uses `fit-file-parser` to decode the binary FIT format.
- **Activity Extraction**: Parses `session` and `record` messages into a normalized format.
- **Advanced Metrics**: Extracts performance data such as Normalized Power (NP), Training Stress Score (TSS), and Intensity Factor (IF).
- **Sensor Data**: High-resolution extraction of Heart Rate, Power, Cadence, Speed, GPS, and running dynamics.
- **IMU Support**: Capable of extracting raw inertial measurement unit data if present in the FIT file.

## Implementation Details

- **Timeout**: File parsing is gated by a 10s timeout to prevent hanging on corrupt files.
- **Normalization**: Binary values are scaled and converted to standard units (m/s for speed, m for distance, etc.) as defined in `parser.ts`.
- **Typing**: `ParsedFitActivity`, `ParsedFitSession`, and `ParsedFitRecord` provide strict interfaces for the extracted data.

## Key Files

- `parser.ts`: Main entry point for FIT file parsing.
- `records.ts`: Definitions for normalized FIT record structures.
- `fixtures/`: Sample FIT files used for testing.
