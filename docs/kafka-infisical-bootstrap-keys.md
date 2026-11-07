# Infisical bootstrap — `KAFKA_CLUSTER_ID` + `KAFKA_BROKERS`

**Status:** **resolved** (Root CONFIG PROVISION COMPLETE). Names-only report —
do **not** print secret values. Do **not** regenerate `KAFKA_CLUSTER_ID`.

Does **not** change existing prod `METRIC_STREAM_*` topic values (Root confirmed
byte-identical). Does **not** broaden CI additional privilege
`gha-kafka-ts-r2-secrets` (still `KAFKA_TIERED_STORAGE_*` only). No default
Cloudflare/Traefik token change. No TF credential stored in Infisical for these
two keys. **No deploy** from this provision alone.

## Keys (prod `/`)

| Infisical name | Provision state | Consumers |
|---|---|---|
| `KAFKA_CLUSTER_ID` | **set** (stock candidate `2G0qJAr9TImYWLduxjq29g`) | `CLUSTER_ID` in `kafka.env` / broker |
| `KAFKA_BROKERS` | **set** (`kafka:9092`) | Web/worker/sinks/archive |

Still **pending TF apply** (not this bootstrap):
`KAFKA_TIERED_STORAGE_{BUCKET,ENDPOINT,REGION,ACCESS_KEY_ID,SECRET_ACCESS_KEY}`.

## Operator note (durable)

1. **Generate once** with stock Kafka storage tool in an **external 384 MiB**
   container — **no broker JVM**:

   ```bash
   docker run --rm --memory=384m --entrypoint /opt/kafka/bin/kafka-storage.sh \
     apache/kafka:4.4.0@sha256:833b867a9585a141da455dc2b57431c65cbccb27f11c91f694444cca9f777e0f \
     random-uuid
   ```

   ([Kafka storage tool / KRaft](https://kafka.apache.org/44/operations/kraft/)).

2. **Root privately** sets Infisical via user auth + stock CLI
   `secrets set --file /dev/stdin` with a **private pipe** (protected stdin —
   no secret on argv, no tempfile, no value in command output). Same workflow for
   `KAFKA_BROKERS=kafka:9092`.
   ([Infisical CLI secrets](https://infisical.com/docs/cli/commands/secrets)).

3. **Verify names-only:** export key names (not values) include both keys.
   Private export comparison may confirm values — never log them into tickets,
   agent chat, or git.

4. **Stability:** never re-run `random-uuid` into Infisical after first set.
   Broker format/data dir binds to that id.

5. Keep `gha-kafka-ts-r2-secrets` scoped to `KAFKA_TIERED_STORAGE_*` only.

## Explicit non-goals

- No custom UUID CLI/framework; no Terraform `random_*` / `ignore_changes` ownership of these two keys
- No topic cutover / `METRIC_STREAM_*` value edits
- No Traefik / default `CLOUDFLARE_API_TOKEN` changes
- No merge/deploy/cutover from this provision alone
