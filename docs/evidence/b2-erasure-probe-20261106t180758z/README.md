# Evidence: B2 erasure probe 20261106t180758z

Sanitized operator artifacts from the one-shot zero-download probe.

| File | Purpose |
|---|---|
| `source.sha256` | Frozen probe script digest |
| `ownership.json` | Bucket/key **names**, application-key **ID**, caps, expiry — no secret key material |
| `probe.execution.json` | Parsed cases with raw HTTP statuses, VersionIds, extras |
| `final.json` | Independent cleanup verification |

Narrative (factual): [`../../r2-to-b2-b2-erasure-probe.md`](../../r2-to-b2-b2-erasure-probe.md)
Design (separate): [`../../r2-to-b2-erasure-design.md`](../../r2-to-b2-erasure-design.md)

## Sanitization audit

Present: resource names, public-ish IDs (`bucketId`, `probeKeyId`), capability strings, timestamps, HTTP statuses/codes, object VersionIds/ETags, harness counters.
Absent: application-key secrets, Authorization headers, request signatures, object bodies, env values.
