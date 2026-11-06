# Stock Kafka (runtime)

Official [`apache/kafka:4.4.0`](https://hub.docker.com/r/apache/kafka) + released
[Aiven tiered-storage-for-apache-kafka v1.2.0](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/releases/tag/v1.2.0)
jars. No custom broker image.

Design authority: [`docs/kafka-tiered-storage-assessment.md`](../../docs/kafka-tiered-storage-assessment.md)
(current plan). **Not rollout-ready:** RSM/TS production waits on object-store
provider selection plus IaC/secrets. Infisical `KAFKA_BROKERS` + topic env must
exist before merge/deploy.

## Pins

| Artifact | Pin |
|---|---|
| Broker image | `apache/kafka:4.4.0@sha256:833b867a9585a141da455dc2b57431c65cbccb27f11c91f694444cca9f777e0f` |
| `core-1.2.0.tgz` | `sha256:14fb636d3a5c781ae9ae961012bf7b0881b09629859dbc784dc49356faeaa747` |
| `s3-1.2.0.tgz` | `sha256:1fd89dea84988b857e546fcfa88504f5b4e45d7712e3eddeb506f11a394ef010` |

## Host plugin layout (immutable version pair)

Target on the existing prod data disk (validated by deploy workflow):

```text
/mnt/dofek-data/kafka/plugins/1.2.0/core/   # exact extract of core-1.2.0/
/mnt/dofek-data/kafka/plugins/1.2.0/s3/     # exact extract of s3-1.2.0/
/mnt/dofek-data/kafka/data/                # broker log dirs bind
```

Publish uses stock `curl` + `sha256sum` + extract of **known** archive roots
(`core-1.2.0/`, `s3-1.2.0/`) into a temp tree, then **one** atomic directory
`mv` of `1.2.0/` into place **if absent**. Never `rm -rf` a version in use;
never `find | head` for extract roots. Re-run is a no-op when the version pair
exists. Cloud-init alone is not sufficient for the live host.

Broker mounts `/mnt/dofek-data/kafka/plugins` **RO** at `/plugins`. Classpath
wiring for RSM is held until the object-store provider and IaC contract land.

## Listeners

| Environment | Bootstrap clients use | Notes |
|---|---|---|
| Local compose | Containers: `kafka:29092`; host: `127.0.0.1:${KAFKA_PORT:-19092}` | Dual listeners; host advertised as `127.0.0.1`, not `kafka` |
| E2E compose | `kafka:29092` | Container-only |
| Production stack | `kafka:9092` | Single listener; do not copy local dual-map |

## Readiness

Broker container healthchecks are **TCP port-liveness only** and must not spawn
operator JVMs (`kafka-topics.sh` / `TopicCommand`) inside the broker cgroup.
Producers and sinks wait on an **external** `kafka-broker-api-versions` client
(`kafka-ready` in compose; deploy workflow wait step on the stack network).

## Tiered storage (held)

Object-store provider choice is still pending. Production stack does **not**
ship RSM env (no blank credential fallbacks, no TS-off feature flag). When TS
is contracted with IaC (lane 87), required keys fail closed by name — do not
invent the full RSM env surface ahead of that alignment.

Credentials (labs / future prod): AWS **default credential chain** in the
broker environment — never `KAFKA_RSM_CONFIG_STORAGE_AWS_ACCESS_KEY_ID` /
`SECRET` static fields (Kafka config logging risk). If Cloudflare R2 is
selected, stock proof requires
`AWS_REQUEST_CHECKSUM_CALCULATION=WHEN_REQUIRED` and
`AWS_RESPONSE_CHECKSUM_VALIDATION=WHEN_REQUIRED`
([R2 Phase F evidence](../../docs/evidence/kafka-ts-r2-phasef-20261106/)).

App metric-stream **JSONL archive** stays on existing R2
(`deploy/redpanda/metric-stream-r2-archive.connect.yml`) and is separate from
Kafka tiered-storage objects.

## Topic generation (archive-safe)

New Kafka writers/sinks/archive must use **v2** topic names so Connect keys
cannot overwrite historical v1 R2 objects when offsets restart at 0. See
assessment current plan. Cutover execution waits on Infisical provision plus
explicit cutover approval; B7 owns app/topic env defaults.
