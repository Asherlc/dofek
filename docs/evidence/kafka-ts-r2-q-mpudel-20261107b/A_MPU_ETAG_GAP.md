# A — multipart ETag gap (metadata-only; no new cloud)

Primary stock proof source if an observed provider ETag exists:
[Cloudflare R2 upload objects](https://developers.cloudflare.com/r2/objects/upload-objects/)
— completed MPU ETag = `'hash-' + numberOfParts` (e.g. `…-2` for two parts).

## Captured metadata search (20261107b)

Searched `/tmp/kafka-ts-r2-q-mpudel-20261107b` and
`docs/evidence/kafka-ts-r2-q-mpudel-20261107b` (incl. `lab-mirror/`).

| Artifact class | Result |
|---|---|
| Root `ListObjectsV2` Key/Size/ETag mid-copy | **Absent** — only post-runtime inventory |
| `ROOT_CLOUD_INVENTORY_BEFORE_CLEANUP.json` | `objectsBeforeOperatorCleanup: []` (no keys/sizes/ETags) |
| Broker/RSM sanitized logs | Copy success + `segmentSizeInBytes=6284624`; **no** ETag / UploadPart / CompleteMultipart strings |
| HeadObject / list capture files | **None** |

**Conclusion:** no actually observed provider `.log` ETag (including `…-2`). Configured
part size + size>partSize remains **eligibility only** — A **not** qualified.

Native physical absence already observed (pre-operator ListObjects=0). Do **not**
repeat full B/C.

## Remaining byte budget (exact)

Original Q11A upload cap: **16 777 216** bytes.

Authoritative prior upload total: **unknown** (no mid-run ListObjects sizes;
cleanup inventory empty). Known closed `.log` floor only:
`6 284 624 + 1 046 445 = 7 331 069` (main+quarantine first closed segments).
Additional remote objects (indexes, manifests, extra deleted segment ids
`Y8PxlT7C…`, `P6i48FwW…`) were uploaded then natively removed — **bytes not
recorded**.

Therefore **remaining = 16 777 216 − (unknown prior total)** cannot be computed
exactly. Do **not** treat `16 777 216 − 7 331 069 = 9 446 147` as remaining
(that **overstates** headroom).

**Gate:** Root must attribute prior upload bytes **or** grant a fresh A-only
byte budget before any allocation.

## Minimal A-only follow-up (plan only — Root review before allocation)

Do **not** execute without Root approval + exact remaining/fresh budget.

1. **Identity:** new disposable bucket nonce (never recreate
   `kafka-ts-r2-q-mpudel-20261107` / `…20261107b`); unused prefix only.
2. **Scope:** A only — one main topic, one closed `.log` with
   `5 242 880 < |log| ≤ 8 388 608`, part size `5 242 880`. No quarantine produce.
   No retention alter. No consume / no object body GET.
3. **Capture BEFORE retention (stock metadata):** after RSM “copy completed”,
   Root `ListObjectsV2` (Key, Size, ETag) and/or `HeadObject` on the remote
   `.log` key — names/sizes/ETags only; **0 body downloads**.
4. **Pass:** observed `.log` ETag matches completed-MPU form `*-N` with
   `N ≥ 2` (for ~6.3 MiB expect `N=2` → suffix `-2`) per Cloudflare docs above,
   plus Size == local closed `.log` bytes. Optional: list-MPU count 0 after
   complete (no orphan MPU).
5. **Stop:** on pass, or budget/wall; then DELETE objects+bucket (no B/C wait).
6. **Wall:** ≤ remaining minutes of original 55 min **only if** Root confirms
   residual wall; else state fresh wall in allocation packet.

No DIY harness; no SDK wire logging; no parent key to Cursor.
