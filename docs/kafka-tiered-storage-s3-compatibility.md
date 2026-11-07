# Kafka tiered storage — B2 / R2 S3 compatibility (stock only)

**Status:** B2 **Phase F PASS** recorded
([`docs/evidence/kafka-ts-b2-phasef-20261106/`](evidence/kafka-ts-b2-phasef-20261106/)).
**No** further cloud allocation / GET / MPU / R2 without a new review.
MPU and R2 remain separate later runs.

**Pins:** Apache Kafka **4.4.0** + Aiven RSM **[v1.2.0](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/releases/tag/v1.2.0)**
(`s3-1.2.0.tgz` `sha256:1fd89dea…`, `core-1.2.0.tgz` `sha256:14fb636d…`; AWS SDK
**2.57.8** from [`build.gradle`](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/blob/v1.2.0/build.gradle)).
Local Seaweed lab PASS / Kafka peak **809 MiB** is **not** B2/R2 proof.
Larger remote-consume workloads remain **unqualified pending retest**. A prior
~256 MiB lab OOM was **confounded** (console consumer ran inside the broker
cgroup and inherited a second **1 GiB** heap beside the broker heap) — do
**not** cite it as proven broker-budget failure.

Tiered storage does **not** replace the existing R2 JSONL archive / erasure
ledger. Pulsar B2 IaC is a separate track. End-to-end remote consume
**downloads** object bytes — it is never a zero-download read proof.

---

## 1. Verdict

| Backend | Stock-config-only? | Notes |
|---|---|---|
| **B2** | **Phase F PASS** (tiny only) | Live Kafka 4.4.0 + RSM 1.2.0 + SDK 2.57.8 against `us-west-004` with `WHEN_REQUIRED`, path-style, default chain, isolated client. **Not** MPU; **not** RSM delete/GC; **`observed_D` unknown**. |
| **R2** | At risk (untested) | Official Java example requires path-style **and** `chunkedEncodingEnabled(false)` ([R2 aws-sdk-java](https://developers.cloudflare.com/r2/examples/aws/aws-sdk-java/)). RSM has path-style only — **no** chunked-encoding knob. CRC32 `FULL_OBJECT` is ❌ on R2 ([S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/)). Stock `WHEN_REQUIRED` is **allowed proposed config**, not proof chunked signing is disabled. Tiny R2 Phase F may be proposed next — **not** approved/executed here. |

Hard rule: released jars + stock plugin/env/JVM only. No custom plugin, SDK
patch, or image.

**Failure classification:** a single HTTP **403** (or similar) while running
with `WHEN_REQUIRED` proves **that tested config failed**. It is **not** an
exhaustive “all stock paths blocked” verdict. Diagnose **auth, clock skew,
endpoint/region/path-style, and credential scope** before attributing the
failure to missing `chunkedEncodingEnabled(false)` or declaring stock-blocked.

---

## 2. RSM v1.2.0 S3 surface (source)

Sources:
[`S3StorageConfig`](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/blob/v1.2.0/storage/s3/src/main/java/io/aiven/kafka/tieredstorage/storage/s3/S3StorageConfig.java),
[`S3ClientBuilder`](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/blob/v1.2.0/storage/s3/src/main/java/io/aiven/kafka/tieredstorage/storage/s3/S3ClientBuilder.java),
[`S3Storage`](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/blob/v1.2.0/storage/s3/src/main/java/io/aiven/kafka/tieredstorage/storage/s3/S3Storage.java) /
[`S3UploadOutputStream`](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/blob/v1.2.0/storage/s3/src/main/java/io/aiven/kafka/tieredstorage/storage/s3/S3UploadOutputStream.java),
[`configs.rst`](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/blob/v1.2.0/docs/configs.rst),
[`KafkaRemoteStorageManager`](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/blob/v1.2.0/core/src/main/java/io/aiven/kafka/tieredstorage/KafkaRemoteStorageManager.java),
[`ObjectKeyFactory.Suffix`](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/blob/v1.2.0/core/src/main/java/io/aiven/kafka/tieredstorage/ObjectKeyFactory.java)
(`log`, `indexes`, `rsm-manifest`).

| Knob | Default | Role |
|---|---|---|
| `s3.bucket.name` / `s3.endpoint.url` / `s3.region` | required / null / required | Bucket + custom endpoint |
| `s3.path.style.access.enabled` | null (auto) | `forcePathStyle` when set |
| `s3.multipart.upload.part.size` | **25 MiB** (min **5 MiB**) | MPU part size; `.log` buffers a full part |
| `aws.checksum.check.enabled` | **false** | Legacy `checksumValidationEnabled` — **not** `requestChecksumCalculation` |
| `s3.legacy.md5.plugin.enabled` | **false** | `LegacyMd5Plugin` (Content-MD5 / older backends; see [#694](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/issues/694)) |
| Static keys / `aws.credentials.file` / `aws.credentials.provider.class` | unset | Else SDK **default credential chain** |
| `chunk.size` (RSM core) | **no default** (docs recommend **4 MiB**) | Required; drives range-fetch grain |
| `fetch.chunk.cache.class` | **null** → uncached `DefaultChunkManager` | Optional `MemoryChunkCache` / `DiskChunkCache` |
| `fetch.chunk.cache.prefetch.max.size` | **0** | No eager prefetch by default |

**Absent:** `requestChecksumCalculation` / `responseChecksumValidation` /
`chunkedEncodingEnabled` plugin knobs.

**Stock AWS SDK env/JVM (proposed):**
`AWS_REQUEST_CHECKSUM_CALCULATION=WHEN_REQUIRED`,
`AWS_RESPONSE_CHECKSUM_VALIDATION=WHEN_REQUIRED`
([SDK data integrity](https://docs.aws.amazon.com/sdkref/latest/guide/feature-dataintegrity.html)).

`AWS_MAX_ATTEMPTS` is documented for **AWS SDK for Java** (shared config /
env / JVM property `aws.maxAttempts`) in
[retry behavior](https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html).
RSM v1.2.0 `S3ClientBuilder` sets `apiCallTimeout` /
`apiCallAttemptTimeout` / metrics only — it does **not** set a retry strategy.
Env-level `AWS_MAX_ATTEMPTS=1` therefore applies to the default SDK retry
policy **unless** a higher-precedence client override is introduced later.
It limits request **attempts**, not downloaded **bytes**, and is **not** a
hard download meter.

**APIs used:** `PutObject`, MPU (`Create`/`UploadPart`/`Complete`/`Abort`),
`GetObject` + `Range`, `DeleteObject`, `DeleteObjects` (≤1000). No List in
`S3Storage` (cleanup tooling is separate).

Upstream integration tests target LocalStack/MinIO-class stand-ins, not B2/R2.

---

## 3. Fetch bound (tiny single closed segment)

Per offloaded segment RSM stores **three** objects: `.log`, `indexes`,
`rsm-manifest`.

Cold-path reads ([`KafkaRemoteStorageManager`](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/blob/v1.2.0/core/src/main/java/io/aiven/kafka/tieredstorage/KafkaRemoteStorageManager.java)):

1. Full GET of `rsm-manifest` (then manifest cache; default size 1000 / 1 h).
2. Per Kafka `IndexType` request: GetRange on `indexes` (indexes cache default
   10 MiB).
3. Log read: GetRange of each **chunk** covering the byte range
   ([`DefaultChunkManager`](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/blob/v1.2.0/core/src/main/java/io/aiven/kafka/tieredstorage/fetch/DefaultChunkManager.java)
   fetches `chunk.range()`). For `|log| < chunk.size`, that is **one** chunk ≈
   `|log|` (not a padded 4 MiB).

With **no** `fetch.chunk.cache.class`, every `fetchLogSegment` re-hits object
storage for that full chunk. Broker call count `K` is **not** fixed by RSM
source. Post-hoc object inventory does **not** cap downloads. No custom
proxy/budget framework.

**Planning model (not an enforced meter):**

Let `L = |log object|`, `I = |indexes object|`, `M = |manifest|`,
`K =` log-chunk GET count, `N_idx ≤ 5` cold index GetRanges.

\[
D \approx M + N_{idx}\cdot I_{slice} + K \cdot L
\]

Phase **F** uses a **~1 MiB** conservative **planning** figure (ideal closer to
~0.25 MiB with warm `MemoryChunkCache` and one finite consume). Overrun is
possible; operator **manual stop** + cleanup — **no hard download cap** is
claimed or enforced in software.

---

## 4. Phased proofs (no implied MPU from tiny Put)

| Phase | Goal | Payload | What it proves | What it does **not** prove |
|---|---|---|---|---|
| **F** Functional | Put path for small objects + GetRange + delete | **≤ 64 KiB** total produce (e.g. 64×1 KiB), one closed remote segment | Stock RSM against backend for tiny `.log`/`indexes`/`manifest` (expect **PutObject**, not MPU, while objects ≪ 5 MiB part min) | MPU / UploadPart; larger-workload memory qualification |
| **M** MPU qualification | Force multipart | One closed segment with `.log` **≥ 5 MiB** (RSM part-size minimum) | `CreateMultipartUpload` / `UploadPart` / `Complete` (+ Abort on failure) | Replaces Phase F; larger-workload memory qualification |

Never claim MPU coverage from a ≤64 KiB payload. First approved cloud run =
**B2 Phase F only**; Phase M and R2 are later, separate approvals.

---

## 5. Proposed stock broker config (B2 Phase F test)

```properties
# RSM core — 8 MiB MemoryChunkCache is TEST configuration only, not production sizing
rsm.config.chunk.size=4194304
rsm.config.fetch.chunk.cache.class=io.aiven.kafka.tieredstorage.fetch.cache.MemoryChunkCache
rsm.config.fetch.chunk.cache.size=8388608
rsm.config.fetch.chunk.cache.prefetch.max.size=0
# S3 backend
rsm.config.storage.backend.class=io.aiven.kafka.tieredstorage.storage.s3.S3Storage
rsm.config.storage.s3.path.style.access.enabled=true
rsm.config.storage.s3.multipart.upload.part.size=5242880
rsm.config.storage.aws.checksum.check.enabled=false
rsm.config.storage.s3.legacy.md5.plugin.enabled=false
# Pass-through: RemoteStorageManagerConfig STORAGE_PREFIX "storage." → S3StorageConfig
# raw keys s3.*; wrong rsm.config.s3.* (no storage.) is ignored (part size stays 25MiB).
# Compose/Kafka Docker: KAFKA_RSM_CONFIG_STORAGE_S3_* (Phase F + deploy/stack.yml).
```

Plus B2 endpoint/region/bucket. Prefer **default credential chain** from
broker-only env (no static keys in checked-in config).

Broker process env (stock SDK):

```text
AWS_REQUEST_CHECKSUM_CALCULATION=WHEN_REQUIRED
AWS_RESPONSE_CHECKSUM_VALIDATION=WHEN_REQUIRED
AWS_MAX_ATTEMPTS=1
```

**Memory caveat:** an 8 MiB `MemoryChunkCache` is **test configuration only**,
not production sizing. A tiny cloud Phase F PASS is functional compat evidence
only — **not** a RAM/size qualification. Larger workloads stay unqualified
until retested with isolated clients (below).

---

## 6. Resource / credential boundaries

### 6.1 Disposable broker lab (Phase F)

| Limit | Proposal |
|---|---|
| Kafka cgroup memory | **2048 MiB** (broker process only) |
| Kafka heap | `-Xmx1G -Xms1G` |
| **Client container** | **Separate** Compose service, cgroup **384 MiB**, explicit JVM heap **256 MiB** |
| Client tools | All admin / producer / consumer CLIs run **only** in that client container |
| Forbidden | `docker exec` (or equivalent) of any Java/Kafka tool **into** the broker cgroup |
| Wall clock | Phase F **≤ 20 min**; manual stop + cleanup if download or errors overrun plan |
| Owned volumes | Lab Compose volumes for broker/data **only**; tear down `--volumes` after |
| Client workload | Finite `max.poll.records` (e.g. 50) + **single** consume-to-EOF then exit |

### 6.2 Credential boundary (exact)

| Role | May hold | Must not hold |
|---|---|---|
| **Account / parent B2 key** | Operator-only | Never injected into agent env, workspace files, or chat logs |
| **Child application key** | Created by operator; injected **only** into the **disposable broker container env** at start | Never written into agent env, repo, evidence trees, or agent-accessible files |
| **Assertions** | Bucket/prefix names, allowlisted API names, pass/fail, non-secret sizes/counts | Secret values, parent keys, JSONL/erasure buckets |

Outer `finally`: revoke child credential; empty bucket (version-aware); delete
bucket; destroy lab volumes.

### 6.3 B2 Phase F

- **Bucket:** new ephemeral bucket (operator create). B2 buckets are
  **versioned by default**
  ([S3-compatible bucket versions](https://www.backblaze.com/docs/cloud-storage-s3-compatible-api-bucket-versions)).
- **Prefix:** `kafka-ts-parity/b2/<date>-<runid>/`
- **Child key caps:** that bucket only — `listFiles`, `readFiles`, `writeFiles`,
  `deleteFiles`. No sibling buckets.
- **Cleanup:** `ListObjectVersions` on **exact prefix**, full pagination;
  delete **every version id and delete marker**; confirm none remain; revoke
  child; delete bucket. `ListObjectsV2` empty is **insufficient**.
- **Download:** plan **~1 MiB** for one finite consumer attempt; overrun
  possible → manual stop. Not a hard cap.

### 6.4 R2 Phase F (operator admin only)

- Bucket create/delete: Cloudflare API **Workers R2 Storage Write**
  ([Create Bucket](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/create/),
  [Delete Bucket](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/delete/)).
- **Stock child path used:** disposable bucket +
  [`POST /accounts/{id}/r2/temp-access-credentials`](https://developers.cloudflare.com/api/resources/r2/subresources/temporary_credentials/methods/create/)
  (`permission=object-read-write`, exact prefix, TTL 3600) → inject
  `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` into
  disposable broker only
  ([temporary credentials](https://developers.cloudflare.com/r2/api/s3/temporary-credentials/)).
- **Create Token / permission_groups** route: blocked this lab (HTTP 403 code
  9109); **do not** broaden tokens. Custom JWT signer: **not** used.
- Never JSONL archive / erasure ledger / other existing R2 buckets.
- Same Phase F/M split; Phase M only under later separate approval.

---

## 7. Execution order

1. **User download exception** (explicit) — required before any cloud
   allocation/GET.
2. Operator: ephemeral B2 bucket + scoped child → inject into disposable
   broker only (checklist below; **not** a maintained repo script).
3. **B2 Phase F only** (~1 MiB expected; single attempt; finite consumer).
4. Record PASS/FAIL + observed bytes/errors; version-aware cleanup + revoke +
   bucket delete + volume teardown.
5. Phase **M** / **R2** only under later separate approvals.

No implementation, stack, CI, or IaC changes in this packet.

---

## 8. Operator checklist — scoped child + broker env (after user approval)

One-shot operator steps; copy values into the disposable broker only. Do **not**
add a maintained bootstrap script for this.

1. Create ephemeral B2 bucket `kafka-ts-b2-f-<date>`.
2. Create **child** application key: bucket-restricted; caps
   `listFiles`, `readFiles`, `writeFiles`, `deleteFiles`.
3. Start disposable Kafka 4.4.0 + RSM 1.2.0 with Section 5 properties and:

   ```text
   AWS_ACCESS_KEY_ID=<child key id>
   AWS_SECRET_ACCESS_KEY=<child key>
   AWS_REQUEST_CHECKSUM_CALCULATION=WHEN_REQUIRED
   AWS_RESPONSE_CHECKSUM_VALIDATION=WHEN_REQUIRED
   AWS_MAX_ATTEMPTS=1
   ```

   plus `rsm.config.storage.s3.bucket.name`, `rsm.config.storage.s3.endpoint.url`, `rsm.config.storage.s3.region` for that
   bucket. Do **not** place child secrets in agent env/files.
4. From the **384 MiB client container** only (heap **256 MiB**): produce
   ≤64 KiB; force one closed segment offload; delete local closed segment;
   single finite consume; stop. Never run those Java tools inside the broker
   cgroup.
5. `finally`: `ListObjectVersions` (prefix, all pages) → delete versions +
   markers → revoke child → delete bucket → `compose down --volumes`.

---

## 9. B2 Phase F result (2026-11-06)

Evidence: [`docs/evidence/kafka-ts-b2-phasef-20261106/`](evidence/kafka-ts-b2-phasef-20261106/).

| Item | Result |
|---|---|
| Verdict | **PHASE_F_PASS** |
| Produce | 64 × 1024 **value** bytes (**65536**); console-producer file **65600** (= values + 64 newlines) — clarify vs “64 KiB”; **not** a hard budget |
| Remote segment | offsets 0–63; `segmentSizeInBytes` **66417**; objects `.log`/`.indexes`/`.rsm-manifest` |
| Local before consume | closed removed; active `…00064.log` only |
| Consume digest | count 64; sha256 match |
| Java isolation | broker 2048 MiB / heap 1 GiB; **all** admin/produce/consume in client 384 MiB / heap 256 MiB |
| `observed_D` | **unknown** (no stock download meter); ~1 MiB was planning only |
| MPU | **not claimed** |
| Cloud cleanup | **operator** B2 native API verified 22:22:53Z (`ROOT_CLOUD_CLEANUP.json`) — **not** RSM `DeleteObjects` / physical GC proof ([Application Keys](https://www.backblaze.com/docs/cloud-storage-application-keys), [S3-Compatible API](https://www.backblaze.com/docs/cloud-storage-s3-compatible-api), [bucket versions](https://www.backblaze.com/docs/cloud-storage-s3-compatible-api-bucket-versions)) |
| Compose teardown | **0** owned containers/volumes |

**Next (recommend only — do not execute here):** Phase **M** (MPU) on B2 and/or R2 under separate explicit approval. No further cloud traffic/repro until new scope.

## 10. Remaining unknowns

1. B2 / R2 **MPU** (Phase M) under RSM 1.2.0 / SDK 2.57.8 — **not** proven by Phase F Put/GetRange.
2. Whether larger R2 workloads still need `chunkedEncodingEnabled(false)` (Phase F tiny objects succeeded with stock `WHEN_REQUIRED` + path-style only; **no** SDK patch).
3. Whether RSM `DeleteObjects` needs `s3.legacy.md5.plugin.enabled=true` on B2/R2 — operator native cleanup ≠ plugin Delete/GC proof.
4. Metered download bytes (`D`) / fetch count `K` for Phase F-class workloads.
5. Path-style auto-detect vs forced `true` on current B2 endpoints (B2 Phase F used forced `true`; R2 Phase F used forced `true` + `region=auto`).
6. Disaster recovery / production readiness — **out of scope** for Phase F.

## 11. R2 Phase F result (2026-11-06)

Evidence: [`docs/evidence/kafka-ts-r2-phasef-20261106/`](evidence/kafka-ts-r2-phasef-20261106/).

| Item | Result |
|---|---|
| Verdict | **PHASE_F_PASS** |
| Config | stock Kafka 4.4.0 + RSM 1.2.0; `AWS_*_CHECKSUM_*=WHEN_REQUIRED`; `s3.region=auto`; path-style=`true`; **no** SDK/plugin patch |
| Produce | 64 × 1024 **value** bytes (**65536**); console-producer file **65600** (= values + 64 newlines) — **not** a hard budget |
| Remote segment | offsets 0–63; `segmentSizeInBytes` **66417**; objects `.log` **66417** / `.indexes` **132** / `.rsm-manifest` **712** |
| Local before consume | closed removed; active `…00064.log` only |
| Consume digest | count 64; sha256 match |
| Java isolation | broker 2048 MiB / heap 1 GiB; **all** admin/produce/consume in client 384 MiB / heap 256 MiB |
| `observed_D` | **unknown** (no stock download meter); ~1 MiB was planning only |
| MPU | **not claimed** |
| Credential path | Create Token / `permission_groups` → **403 code 9109** (blocked; no broaden). Stock **temp-access-credentials** + CF create bucket → **success**. No custom JWT; no paid setup; parent never in broker. |
| Cloud cleanup | **operator** parent S3 in-memory + CF DELETE verified 23:08Z (`ROOT_CLOUD_CLEANUP.json`) — **manual**, **not** RSM `DeleteObjects` / physical GC proof. Session has **no** revoke API (TTL); parent unchanged; do not recreate same bucket name before expiry without review. |
| Compose teardown | **0** owned containers/volumes **before** cloud cleanup |

**Clarify:** simple Put/GetRange PASS does **not** prove MPU, disaster recovery, or production readiness. No more cloud traffic/repro until a new approved scope.

---

## Sources

- [Aiven RSM v1.2.0](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/releases/tag/v1.2.0),
  [configs.rst](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/blob/v1.2.0/docs/configs.rst),
  [S3ClientBuilder](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/blob/v1.2.0/storage/s3/src/main/java/io/aiven/kafka/tieredstorage/storage/s3/S3ClientBuilder.java),
  [KafkaRemoteStorageManager](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/blob/v1.2.0/core/src/main/java/io/aiven/kafka/tieredstorage/KafkaRemoteStorageManager.java)
- [AWS data integrity](https://docs.aws.amazon.com/sdkref/latest/guide/feature-dataintegrity.html),
  [AWS retry / `AWS_MAX_ATTEMPTS`](https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html)
- [B2 Java V2](https://www.backblaze.com/docs/cloud-storage-use-the-aws-sdk-for-java-v2-with-backblaze-b2),
  [B2 bucket versions](https://www.backblaze.com/docs/cloud-storage-s3-compatible-api-bucket-versions),
  [B2 application keys](https://www.backblaze.com/docs/cloud-storage-application-keys),
  [B2 S3-Compatible API](https://www.backblaze.com/docs/cloud-storage-s3-compatible-api)
- [R2 Java example](https://developers.cloudflare.com/r2/examples/aws/aws-sdk-java/),
  [R2 checksums / S3 API](https://developers.cloudflare.com/r2/api/s3/api/),
  [R2 tokens](https://developers.cloudflare.com/r2/api/tokens/),
  [R2 temporary credentials](https://developers.cloudflare.com/r2/api/s3/temporary-credentials/),
  [R2 temp-access-credentials API](https://developers.cloudflare.com/api/resources/r2/subresources/temporary_credentials/methods/create/),
  [R2 Create Bucket API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/create/),
  [R2 Delete Bucket API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/delete/)
