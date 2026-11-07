# Sanitized evidence — `kafka-ts-lab-20261106`

Local-only stock Apache Kafka **4.4.0** + Aiven tiered-storage plugin **v1.2.0**
functional proof against a SeaweedFS S3 stand-in.

Nonsecret artifacts only. No credentials, no payload bodies, no host env dumps,
no custom maintained CLI, no B2/cloud object traffic.

Narrative:
[`docs/kafka-tiered-storage-assessment.md`](../../kafka-tiered-storage-assessment.md#november-6-local-functional-lab-kafka-ts-lab-20261106).

## Scope (PASS bound)

| Item | Value |
|---|---|
| Verdict | **CORE_PROOF_PASS** for this small functional fixture only |
| Adoption / pivot | **Not** claimed |
| RAM vs Pulsar 256 MiB fixture | **Not** compared / **not** claimed |
| Kafka cgroup | 2048 MiB from start |
| Kafka heap | `-Xmx1G -Xms1G` (official `kafka-server-start.sh` default) |
| Seaweed stand-in | 1024 MiB local Compose only |
| Tool | `amazon/aws-cli:2.38.2` ≤384 MiB |
| Workload | 5000 × 1 KiB distinct messages; one topic |
| Integrity | Closed local segments removed → earliest remote digest → broker restart → matching count/order/digest |

**Not claimed:** Pulsar equivalence, production sizing, B2 compatibility, sustained
load, outage/soak, dual-topic overlapping offload (reserved for a later
Root-gated lab).

## Exact image / plugin hashes

| Artifact | Pin |
|---|---|
| Kafka image | `apache/kafka:4.4.0` · repo digest `sha256:833b867a9585a141da455dc2b57431c65cbccb27f11c91f694444cca9f777e0f` |
| SeaweedFS | `chrislusf/seaweedfs:4.48` · `sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d` |
| Tool | `amazon/aws-cli:2.38.2` · `sha256:5d39fd52f236ed01c5c25fba66c9aebcfc6cbb88e7bb1b727c5fe1f150540597` |
| Plugin release | [Aiven v1.2.0](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/releases/tag/v1.2.0) (`published_at` 2026-11-06T11:18:29Z) |
| `core-1.2.0.tgz` | `sha256:14fb636d3a5c781ae9ae961012bf7b0881b09629859dbc784dc49356faeaa747` |
| `s3-1.2.0.tgz` | `sha256:1fd89dea84988b857e546fcfa88504f5b4e45d7712e3eddeb506f11a394ef010` |

Official docs:
[Kafka 4.4 tiered storage](https://kafka.apache.org/44/operations/tiered-storage/),
[TS configs](https://kafka.apache.org/44/configuration/tiered-storage-configs/),
[Aiven configs](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/blob/v1.2.0/docs/configs.rst).

## Observed lifetime peaks (`memory.peak`)

| Role | Peak | Limit | Headroom | oom / oom_kill / max |
|---|---:|---:|---:|---|
| kafka | 809.2 MiB | 2048 MiB | 1238.8 MiB | 0 / 0 / 0 |
| seaweed | 107.1 MiB | 1024 MiB | 916.9 MiB | 0 / 0 / 0 |
| tool | 64.4 MiB | 384 MiB | 319.6 MiB | 0 / 0 / 0 |

**Peak meaning:** cgroup v2 `memory.peak` is a **lifetime** high-water mark for
the container cgroup, including across an in-place broker restart of the same
container. It is **not** a per-phase sample and **not** a Pulsar-fixture RAM
comparison.
([cgroup v2 memory interface files](https://docs.kernel.org/admin-guide/cgroup-v2.html#memory-interface-files)).

**Monitor coverage:** intended 5 s sampler wrote few lines and did **not**
reliably span the restart window (`cgroup-monitor-coverage.json`). Final
oneshot `memory.peak` / `memory.events` remain authoritative for the whole
lifetime.

## Verification

1. **Local removal before earliest hash:** `tieredTopic-0` retained only active
   `00000000000000005000.log`; closed bases `0/1005/2010/3015/4020` present in
   stand-in inventory only.
2. **Digest / count:** 5000 messages, offsets `0..4999`, sha256
   `a1cc5c88bfe4f73c8a665027752d81cbd5c2f12f8ad504457ecb6ef405bde616`.
3. **After restart:** same count/order/digest (`hash-b` matches `hash-a`).
4. **Object inventory:** 15 keys under local prefix (5× `.log` + indexes +
   manifests).
5. **Cleanup:** `compose … down --volumes`; zero owned containers/volumes left.

## Files

- `CORE_PROOF.json` / `CORE_PROOF.sha256`
- `hash-a.json`, `hash-b.json` (payload bodies omitted)
- `cgroup-final.json`, `cgroup-monitor-coverage.json`
- `object-inventory-final.txt`, `local-tieredTopic-*.txt`
- `plugin-provenance.json`, `kafka-flags.txt`, `preflight.json`
- wall-clock / restart / cleanup timestamps
