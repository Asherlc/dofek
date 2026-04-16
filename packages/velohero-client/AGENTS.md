# VeloHero Client Agent Guide

> Read [README.md](./README.md) first for general architecture and usage.

## Auth Details
VeloHero's `/sso` endpoint returns a JSON response containing a `session` token. This token must be prefixed with `VeloHero_session=` and sent in the `Cookie` header for all subsequent API calls.

## Endpoints
- **List**: `/export/workouts/json?date_from=...&date_to=...`
- **Detail**: `/export/workouts/json/{id}`

Note that VeloHero uses simple date formats (YYYY-MM-DD) for its export filters.
