# Infisical bootstrap — `KAFKA_CLUSTER_ID` + `KAFKA_BROKERS` (review only)

**Status:** options for Root/user review. **No Infisical writes** from this doc.
Does **not** change existing prod `METRIC_STREAM_*` topic values. Does **not**
broaden CI additional privilege `gha-kafka-ts-r2-secrets` (still
`KAFKA_TIERED_STORAGE_*` only) without a separate IAM review.

Context: names-only audit showed both keys **missing** in Infisical prod `/`.
Deploy renderer already requires them for `kafka.env`
([`scripts/deploy-service-environment.ts`](../scripts/deploy-service-environment.ts)):
`KAFKA_CLUSTER_ID` → `CLUSTER_ID`; sinks/archive need `KAFKA_BROKERS`.
Desired prod bootstrap: **`kafka:9092`**. Cluster id must be **stable** across
apply/restart ([`deploy/kafka/README.md`](../deploy/kafka/README.md)).

## Exact keys (create once)

| Infisical name | Intended value | Consumers |
|---|---|---|
| `KAFKA_CLUSTER_ID` | One KRaft UUID string (base64url, stock format) | `CLUSTER_ID` in `KAFKA_ENV_FILE` / broker |
| `KAFKA_BROKERS` | `kafka:9092` | Web/worker/sinks/archive (`KAFKA_BROKERS` only; no Redpanda alias) |

Do **not** invent topic keys or rewrite `METRIC_STREAM_LEGACY_TOPIC` /
`LIVE` / `HISTORY` here. `KAFKA_TIERED_STORAGE_*` remain TF-apply-owned after
`CLOUDFLARE_TERRAFORM_R2_API_TOKEN` path.

## Recommended approach (smallest): stock one-time bootstrap + operator Infisical set

1. **Generate id once** with stock Kafka tool (no DIY generator):

   ```bash
   docker run --rm --entrypoint /opt/kafka/bin/kafka-storage.sh \
     apache/kafka:4.4.0@sha256:833b867a9585a141da455dc2b57431c65cbccb27f11c91f694444cca9f777e0f \
     random-uuid
   ```

   Official format used by KRaft formatting
   ([Kafka storage tool / KRaft](https://kafka.apache.org/44/operations/kraft/)).

2. **Root privately** (user auth Infisical CLI — not CI identity) set namespaced
   secrets in prod `/` (values never logged):

   - `KAFKA_CLUSTER_ID=<uuid from step 1>`
   - `KAFKA_BROKERS=kafka:9092`

   Stock Infisical CLI `secrets set` / dashboard — existing operator workflow
   ([Infisical CLI secrets](https://infisical.com/docs/cli/commands/secrets)).

3. **Verify names-only:** `infisical export --env=prod --format=json | jq -r '.[].key'`
   shows both keys present. No value print.

4. **Do not** add these keys to `gha-kafka-ts-r2-secrets` unless CI must
   *write* them (it should not — read comes through normal deploy Infisical
   export). Keep additional privilege scoped to `KAFKA_TIERED_STORAGE_*`.

5. **Stability:** never re-run `random-uuid` into Infisical after first set;
   broker format/data dir binds to that id. TF apply must not regenerate it.

## Alternate (only if TF must own the values)

Use HashiCorp `random_id` / `random_string` **once** with lifecycle
`ignore_changes` or a moved resource, write via `infisical_secret` like
`KAFKA_TIERED_STORAGE_*`. Heavier: needs Infisical provider auth in
`deploy-terraform`, and today CI privilege **cannot** create arbitrary secret
names without IAM broaden. Prefer **not** this path unless review explicitly
wants TF ownership of cluster id.

## Explicit non-goals

- No custom UUID CLI/framework in-repo
- No topic cutover / v2 value changes in this bootstrap
- No Traefik/`CLOUDFLARE_API_TOKEN` changes
- No apply/merge/deploy from this doc alone
