# TCX Parser

This directory contains logic for parsing Training Center XML (TCX) files.

## Core Features

- **XML Parsing**: Uses `sax` for fast, streaming XML parsing.
- **Trackpoint Extraction**: Extracts `recordedAt`, GPS, altitude, heart rate, cadence, speed, and power from trackpoints.
- **Metric Stream Integration**: Converts trackpoints into `MetricStreamSourceRow` for easy database insertion.

## Implementation Details

- **Fast & Efficient**: `parseTcx` uses a streaming XML parser to handle large TCX files without high memory overhead.
- **Unit Normalization**: GPS and altitude are extracted and kept in standard decimal units.

## Key Files

- `parser.ts`: Main TCX parsing logic and conversion utility.
