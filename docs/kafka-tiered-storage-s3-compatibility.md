# Kafka tiered storage — B2 / R2 S3 compatibility (stock only)

**Status:** source/config assessment. **No** cloud allocation, writes, or object
GETs until an **explicit user download exception**. First cloud attempt (when
approved): **B2 Phase F only**. MPU and R2 are separate later runs.

**Pins:** Apache Kafka **4.4.0** + Aiven RSM **[v1.2.0](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/releases/tag/v1.2.0)**
(`s3-1.2.0.tgz` `sha256:1fd89dea…`, `core-1.2.0.tgz` `sha256:14fb636d…`; AWS SDK
**2.57.8** from [`build.gradle`](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/blob/v1.2.0/build.gradle)).
Local Seaweed lab PASS / Kafka peak **809 MiB** is **not** B2/R2 proof and is
**not** a memory qualification for larger remote-consume workloads.

Tiered storage does **not** replace the existing R2 JSONL archive / erasure
ledger. Pulsar B2 IaC is a separate track. End-to-end remote consume
**downloads** object bytes — it is never a zero-download read proof.

---

## 1. Verdict

| Backend | Stock-config-only? | Notes |
|---|---|---|
| **B2** | Plausible, unproven | Endpoint/region/path-style/creds/MPU knobs exist. Vendor claims checksum-header support since July 2025; live RSM Put/GetRange/DeleteObjects under SDK 2.57.8 still unknown. |
| **R2** | At risk | Official Java example requires path-style **and** `chunkedEncodingEnabled(false)` ([R2 aws-sdk-java](https://developers.cloudflare.com/r2/examples/aws/aws-sdk-java/)). RSM has path-style only — **no** chunked-encoding knob. CRC32 `FULL_OBJECT` is ❌ on R2 ([S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/)). Stock `WHEN_REQUIRED` env/JVM is **allowed proposed config**, not proof that chunked signing is disabled. |

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
| **F** Functional | Put path for small objects + GetRange + delete | **≤ 64 KiB** total produce (e.g. 64×1 KiB), one closed remote segment | Stock RSM against backend for tiny `.log`/`indexes`/`manifest` (expect **PutObject**, not MPU, while objects ≪ 5 MiB part min) | MPU / UploadPart; memory fit for larger remote consume |
| **M** MPU qualification | Force multipart | One closed segment with `.log` **≥ 5 MiB** (RSM part-size minimum) | `CreateMultipartUpload` / `UploadPart` / `Complete` (+ Abort on failure) | Replaces Phase F; memory qualification |

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
rsm.config.s3.path.style.access.enabled=true
rsm.config.s3.multipart.upload.part.size=5242880
rsm.config.aws.checksum.check.enabled=false
rsm.config.s3.legacy.md5.plugin.enabled=false
```

Plus B2 endpoint/region/bucket. Prefer **default credential chain** from
broker-only env (no static keys in checked-in config).

Broker process env (stock SDK):

```text
AWS_REQUEST_CHECKSUM_CALCULATION=WHEN_REQUIRED
AWS_RESPONSE_CHECKSUM_VALIDATION=WHEN_REQUIRED
AWS_MAX_ATTEMPTS=1
```

**Memory caveat:** an 8 MiB chunk cache on a **2 GiB** cgroup does **not**
memory-qualify larger remote-consume cases (e.g. ~256 MiB segment working set
can still pressure/OOM the broker). A tiny cloud Phase F PASS is functional
compat evidence only — **not** a RAM/size qualification.

---

## 6. Resource / credential boundaries

### 6.1 Disposable broker lab (Phase F)

| Limit | Proposal |
|---|---|
| Kafka cgroup memory | **2048 MiB** |
| Kafka heap | `-Xmx1G -Xms1G` |
| Wall clock | Phase F **≤ 20 min**; manual stop + cleanup if download or errors overrun plan |
| Owned volumes | Lab Compose volumes for broker/data **only**; tear down `--volumes` after |
| Client | Finite `max.poll.records` (e.g. 50) + **single** consume-to-EOF then exit |

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

### 6.4 R2 (later; operator admin only)

- Bucket create/delete: Cloudflare API **Workers R2 Storage Write**
  ([Create Bucket](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/create/)).
- Object token: **Object Read & Write**, that bucket only
  ([R2 tokens](https://developers.cloudflare.com/r2/api/tokens/)).
- Never JSONL archive / erasure ledger buckets.
- Same Phase F/M split when separately approved.

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

   plus `rsm.config.s3.bucket.name`, `s3.endpoint.url`, `s3.region` for that
   bucket. Do **not** place child secrets in agent env/files.
4. Produce ≤64 KiB; force one closed segment offload; delete local closed
   segment; single finite consume; stop.
5. `finally`: `ListObjectVersions` (prefix, all pages) → delete versions +
   markers → revoke child → delete bucket → `compose down --volumes`.

---

## 9. Unknowns (remain until executed)

1. B2 + Java SDK 2.57.8 under the Section 5 config on RSM Put/GetRange/DeleteObjects.
2. Whether `WHEN_REQUIRED` alone satisfies R2 (later) without chunked-encoding off.
3. Whether DeleteObjects needs `s3.legacy.md5.plugin.enabled=true`.
4. Observed `K` and `D` under Kafka 4.4 remote read for Phase F.
5. Path-style auto-detect vs forced `true` on current B2 endpoints.

---

## Sources

- [Aiven RSM v1.2.0](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/releases/tag/v1.2.0),
  [configs.rst](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/blob/v1.2.0/docs/configs.rst),
  [S3ClientBuilder](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/blob/v1.2.0/storage/s3/src/main/java/io/aiven/kafka/tieredstorage/storage/s3/S3ClientBuilder.java),
  [KafkaRemoteStorageManager](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/blob/v1.2.0/core/src/main/java/io/aiven/kafka/tieredstorage/KafkaRemoteStorageManager.java)
- [AWS data integrity](https://docs.aws.amazon.com/sdkref/latest/guide/feature-dataintegrity.html),
  [AWS retry / `AWS_MAX_ATTEMPTS`](https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html)
- [B2 Java V2](https://www.backblaze.com/docs/cloud-storage-use-the-aws-sdk-for-java-v2-with-backblaze-b2),
  [B2 bucket versions](https://www.backblaze.com/docs/cloud-storage-s3-compatible-api-bucket-versions)
- [R2 Java example](https://developers.cloudflare.com/r2/examples/aws/aws-sdk-java/),
  [R2 checksums / S3 API](https://developers.cloudflare.com/r2/api/s3/api/),
  [R2 tokens](https://developers.cloudflare.com/r2/api/tokens/),
  [R2 Create Bucket API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/create/)
