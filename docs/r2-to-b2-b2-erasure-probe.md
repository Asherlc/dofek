# B2 zero-download erasure probe report

**Executed once:** `2026-11-06T18:19:18.773Z` · full cleanup complete  
**Frozen source:** ephemeral `/tmp/b2-erasure-probe.ts` (not a maintained repo CLI)  
**SHA256:** `5fd159e002ecd97d97a6c23b2358fbcb1eed5b36ffe68f5824b675eef521ec44`  
**Raw sanitized evidence:** [`docs/evidence/b2-erasure-probe-20261106t180758z/`](evidence/b2-erasure-probe-20261106t180758z/)

Factual B2 compatibility probe record only. Does **not** authorize an R2→B2 bucket migration, CAS replacement, or product cutover. Broader migration remains **deferred**. The Pulsar/B2 offload proposal belonged to the [superseded PR #3231](https://github.com/Asherlc/dofek/pull/3231), not the current [Kafka architecture](../README.md#architecture).

No Object GET · no MPU · no retention · no R2/prod ops · no secret key material in artifacts · no probe rerun.

## Primary vendor references

- Put (Native API): [b2_upload_file](https://www.backblaze.com/apidocs/b2-upload-file)  
- Copy (Native API): [b2_copy_file](https://www.backblaze.com/apidocs/b2-copy-file)  
- Object Lock / legal hold: [Object Lock](https://www.backblaze.com/docs/cloud-storage-object-lock) · [Enable Object Lock with the Native API](https://www.backblaze.com/docs/cloud-storage-enable-object-lock-with-the-native-api)  
- S3-compatible API (versioned-by-default note): [Introduction to the S3-Compatible API](https://www.backblaze.com/apidocs/introduction-to-the-s3-compatible-api)

## Scope

| Item | Value |
|---|---|
| Bucket | `dofek-b2-erasure-probe-20261106t180758z` (Object Lock on, default retention null) |
| Prefix | `probe/20261106t180758z/` |
| Child key name | `codex-b2-erasure-probe-20261106t180758z` |
| Caps | list/read/write/delete files + read/write legal holds (no bucket ops) |
| Endpoint / region | `https://s3.us-west-004.backblazeb2.com` / `us-west-004` |
| Bounds | ≤20 keys · ≤102400 body bytes · 0 body GET |

## Harness summary

| Field | Value |
|---|---|
| Process exit | 0 (harness completed; **not** “all contracts supported”) |
| Cases | 17 |
| Owned keys | 11 |
| `uploadedBytes` | 168 (attempt counter) |
| `fatalUnexpected` | null |
| `cleanupFailed` | false |
| Outer cleanup | bucket deleted · key revoked · 0 versions · 0 unfinished uploads · 0 identity matches |

## Case outcomes (raw HTTP over case `ok`)

Do **not** treat case `ok=true` under HTTP 501 as support proof.

| Case | HTTP | Factual assertion |
|---|---|---|
| IfNoneMatch.new | 501 NotImplemented | Conditional create **unsupported** on this fixture |
| IfNoneMatch.existing | 501; seed VersionId unchanged; versionCount 1 | Unconditional seed held; conditional Put still **unsupported** |
| IfNoneMatch.concurrent | 403 Unknown | **UNQUALIFIED** — not conditional-race proof |
| CopySource.setup | 200 | Seed OK |
| CopySourceIfMatch.good | 200 | Valid `CopySourceIfMatch` request **accepted**; destination VersionId observed. **Does not** prove mismatch **enforcement** (see bad case) |
| CopySourceIfMatch.bad | 403 Unknown | **UNQUALIFIED** — opaque failure; **not** standard 412 precondition semantics; enforcement **unproven** |
| DestIfMatch.setup | 200 | Seed OK |
| DestIfMatch.good | 501 NotImplemented | Destination Copy IfMatch **unsupported** |
| DestIfMatch.bad | 501; before/current VersionId unchanged | 501 only; **not** dest-guard proof |
| CF.destHeader.control | 200 | Header accepted **or** ignored; **not** a conditional guard |
| LegalHold.setup | ON succeeded | Hold attached to exact VersionId |
| LegalHold.overwritePut | 200 + new current VersionId | Hold does **not** freeze current-key view |
| LegalHold.deleteExactVersion | 403 AccessDenied | Held-version delete **blocked** |
| LegalHold.off | 200 | OFF confirmed for held VersionId |
| Gzip.headEncoding | 200; HEAD `contentEncoding=gzip` | Encoding via HEAD only; no body-read claim |
| History.keyOnlyThenAllVersions | after key-only: 2 versions + 1 marker; after explicit deletes: 0/0 | Key-only hides; versioned delete purges |
| Staging.retainNewPurgeOld | retained intended VersionId; deleted 1 superseded; list count 1 | Retain-new / purge-old mechanics OK |

Exact VersionIds/ETags: `probe.execution.json` extras (no credentials).

## Sanitization note

Artifacts contain bucket/key **names**, application-key **IDs**, capability names, HTTP statuses, and object VersionIds/ETags. They do **not** contain application-key secrets, request signatures, or object bodies.
