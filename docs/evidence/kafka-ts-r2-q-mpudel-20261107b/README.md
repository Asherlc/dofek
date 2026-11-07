# Evidence — kafka-ts-r2-q-mpudel-20261107b (strict)

Bounded disposable R2 lab (user Q11A). Runtime stopped `2026-11-07T03:56:49Z`.
Root cleanup verified `2026-11-07T03:57:35.924Z`. Prefix
`kafka-ts-parity/r2/20261107b-q-mpudel/`. **Do not recreate bucket.**

Canonical claim file: [`CORE_PROOF.json`](./CORE_PROOF.json). Full lab mirror:
[`lab-mirror/`](./lab-mirror/).

## Verdicts (honest)

| Check | Qualified? | What is proven | Gap |
|---|---|---|---|
| **A MPU** | **No** | Configured `s3.multipart.upload.part.size=5242880`; main `segmentSizeInBytes=6284624` (> part size = **eligibility**); RSM “Copying log segment data completed successfully” for main+quarantine | No CreateMultipartUpload / UploadPart / CompleteMultipartUpload / multipart ETag / remote object sizes. Size>partSize is **not** UploadPart proof ([assessment](../../kafka-tiered-storage-assessment.md) MPU row). |
| **B Delete** | **Partial** | `About to delete remote` for main+quarantine segment ids; **pre-operator** ListObjectsV2=0 and list-MPU=0 ([`ROOT_CLOUD_INVENTORY_BEFORE_CLEANUP.json`](./ROOT_CLOUD_INVENTORY_BEFORE_CLEANUP.json)); operator deletes/aborts=0 | `DELETE_SEGMENT_FINISHED` not in logs; RLMM metadata dump not captured. About-to-delete ≠ finished. |
| **C Consume** | **Partial** | `CONSUME_EXIT=0`; reported `6060` lines for `/tmp/consume-main.out`; aligns with copy metadata offsets 0–6059 | Message bodies not preserved; **order** and **content hash** not checked. |

## Cleanup (Root)

[`ROOT_CLOUD_CLEANUP.json`](./ROOT_CLOUD_CLEANUP.json): DELETE bucket HTTP 200, GET 404,
0 owned containers/volumes, 0 body GETs, parent not revoked.

## Budget

Known closed `.log` bytes only: 6284624 + 1046445 = 7331069 (&lt; 16 MiB). No
authoritative ListObjects size sum (inventory empty at cleanup time).
