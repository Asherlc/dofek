# Account Erasure Runbook

<!-- cspell:ignore peerdbbucket -->

Account erasure is a durable, fail-closed workflow. Confirmation immediately
revokes the user's sessions and activates database and identity write fences.
The background coordinator then erases Dofek-controlled data, waits for the
seven-day event-replay boundary, repeats the destructive checks, removes
identifying fields from the request, verifies processor and backup retention,
proves that pre-boundary Redpanda quarantine payloads are physically absent,
and reports completion no later than 30 days after the request.

This runbook covers account erasure, not the narrower removal of one provider's
data. Use the [provider data deletion runbook](provider-data-deletion-runbook.md)
for the latter.

The product contract follows Apple's in-app account-deletion requirement,
Google Play's account-deletion policy, and the right-to-erasure framework in
GDPR Article 17:

- <https://developer.apple.com/support/offering-account-deletion-in-your-app>
- <https://support.google.com/googleplay/android-developer/answer/13327111>
- <https://eur-lex.europa.eu/eli/reg/2016/679/art_17/oj/eng>

## Safety Invariants

- A user must type `DELETE` and have authenticated within the preceding 15
  minutes before preparing a request.
- Confirmation is atomic with session revocation, identity and user write
  fences, the durable request, and its outbox record.
- The opaque status token is the only credential accepted by the public status
  mutation after sessions are revoked. Treat it as a secret; never put it in a
  URL, log, ticket, screenshot, or chat message.
- The fence stays active after a failed attempt. Never re-enable sign-in, sync,
  uploads, webhooks, companion writes, or queued writes to make a request look
  complete.
- Completed checkpoints are idempotent. Repair the failing dependency and let
  the worker resume; do not delete checkpoints or manually mark a phase
  complete.
- The request cannot complete before both the seven-day replay boundary and the
  29-day internal retention-verification point. That point and the required
  processor retention ceiling preserve one full day to retry the proof before
  the public 30-day completion deadline.
- After a write fence rejects work, telemetry and logs must not emit stable
  account, provider-account, workspace, channel, message, or payload
  identifiers. Expected fence rejection is acknowledged without reporting the
  erased identity to a processor.
- The user-facing status never exposes `last_error` or checkpoint details.
- Dofek removes data it wrote to HealthKit during client cleanup. Apple-owned
  HealthKit and Core Motion source data remain under OS control and must not be
  described as server-deleted.

PostgreSQL transactions provide the all-or-nothing boundary used at
confirmation: <https://www.postgresql.org/docs/current/tutorial-transactions.html>.
BullMQ jobs are designed to be idempotent because delivery can be retried:
<https://docs.bullmq.io/patterns/idempotent-jobs>.

## Native delivery coordination inventory

The native delivery schema adds two shared-system PostgreSQL tables:

- `fitness.analytics_stream_state` stores transport positions, an owner nonce,
  and a bounded group descriptor containing positions, count, digest and an
  ingestion-time reservation. It contains no event payload or account key.
- `fitness.analytics_query_owner` stores the publication resource, owner nonce,
  backend/query identifiers, terminal state and a digest-derived delivery intent.
  Delivery intents must not contain account identifiers.

These classifications follow the [schema](../src/db/schema/analytics-work.ts),
[delivery admission](../src/analytics/analytics-work-store.ts),
[intent construction](../src/analytics/analytics-delivery-group.ts) and
[query owner](../src/analytics/analytics-query-owner.ts). The existing
[PostgreSQL erasure coverage check](../src/account-erasure/postgres-erasure.ts)
recognizes both tables. This inventory covers coordination state; it does not
replace erasure of raw rows, the effect journal, placements or archives.

## User Flow

1. The signed-in user opens account deletion on web or iOS, types `DELETE`, and
   prepares the request.
2. The client confirms with the short-lived preparation capability.
3. The server records the immutable deletion-ledger intent, activates the fences,
   revokes sessions, and returns the status capability.
4. Web and iOS purge Dofek-controlled local state. iOS also asks each native and
   watch module to remove buffered Dofek data and records a device cutoff so
   stale background work cannot resume.
5. The user can reopen `/account-deletion` or the equivalent iOS screen with the
   locally retained status capability. Losing that capability does not stop
   deletion; support can use the request ID without receiving the token.
6. Automatic retries continue until every phase verifies or an operator fixes a
   failing dependency.

The public states are:

| Status | Meaning |
|--------|---------|
| `pending` | Confirmation committed, but no worker has claimed the request yet. |
| `running` | A worker owns a renewable lease and is advancing phases. |
| `waiting_replay` | Initial erasure passed; the coordinator is waiting for the seven-day Redpanda replay boundary. |
| `waiting_retention` | Active data and request PII are gone; the coordinator is waiting for the final quarantine, processor, and backup retention checks. |
| `failed` | A phase failed and is scheduled for automatic retry, or requires support if no retry time is present. The fences remain active. |
| `completed` | Replay, active-store, quarantine, processor-retention, and backup-retention verification passed. |

## Phase Map

The persisted phase names are deliberately stable so operators can correlate a
status, checkpoint, and Sentry event.

| Phase group | Persisted phases | Required evidence |
|-------------|------------------|-------------------|
| Immediate safety | `ingest_fence`, `stripe_erasure`, `work_purge`, `consumer_drain` | ClickHouse ingest is fenced; Stripe deletion finished; BullMQ/Redis/files/objects are quiescent; native Pulsar `lastMessageId` fences are captured and subscription `markDelete` cursors have crossed them. Attributed metric-stream publishes are rejected by `fitness.lock_and_reject_account_erasure_write` from request creation ([`write-metric-stream.ts`](../src/metric-stream/write-metric-stream.ts), [`metric-stream-writer.ts`](../src/db/metric-stream-writer.ts)); archive upload holds the same advisory keys through PUT ([`account-erasure-delivery-fence.ts`](../src/db/account-erasure-delivery-fence.ts)). Stripe's customer-delete behavior is documented at <https://docs.stripe.com/api/customers/delete>. Pulsar documents message retention and expiry at <https://pulsar.apache.org/docs/4.0.x/cookbooks-retention-expiry/> — TTL alone never ACKs drain. |
| Initial erasure | `remote_revocation`, `processor_erasure`, `postgres_erasure`, `clickhouse_initial`, `archive_initial` | Remote credentials are revoked or proven already absent; processor deletions are queued; attributable Postgres and ClickHouse data is removed; mixed-user R2 archives are conditionally rewritten. Cloudflare documents R2 conditional S3 writes at <https://developers.cloudflare.com/r2/api/s3/api/>. |
| Replay verification | `work_verification`, `consumer_drain_verification`, `stripe_erasure_verification`, `remote_revocation_verification`, `processor_erasure_verification`, `postgres_profile_delete`, `peerdb_drain_verification`, `clickhouse_verification`, `archive_verification`, `request_pii_scrub` | No late work or replay can recreate data; Stripe and other remote processors re-acknowledge deletion; PeerDB has crossed the captured PostgreSQL WAL position; ClickHouse and R2 pass a second sweep; live request PII is removed. |
| Retention verification | `retention_verification` | At day 29: stock Pulsar/BookKeeper physical maintenance is operator-acknowledged under `phase_progress.retention_verification` (see [Stock physical maintenance acknowledgement](#stock-physical-maintenance-acknowledgement)); Axiom and Sentry retention are at most 29 days; database backups are at most 21 days old and none from at or before the PII-scrub boundary remain. TTL elapsed alone never satisfies the Pulsar physical gate. |

The coordinator may execute independent phases in one group before reporting an
aggregate failure. A later checkpoint in the same group does not make the
failed sibling optional.

## Deployment Prerequisites

The deploy workflow validates required values before rollout. Store them in the
production Infisical environment; never commit values to this repository.

| Purpose | Required configuration |
|---------|------------------------|
| Immutable restore ledger | `CREDENTIAL_ENCRYPTION_KEY_BASE64`, `ACCOUNT_ERASURE_LEDGER_KEYRING_JSON`, `ACCOUNT_ERASURE_LEDGER_R2_BUCKET`, `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` |
| Remote processors | `BREVO_API_KEY`, `POSTHOG_PERSONAL_API_KEY`, `POSTHOG_PROJECT_ID`, `ZOHO_DESK_CLIENT_ID`, `ZOHO_DESK_CLIENT_SECRET`, `ZOHO_DESK_REFRESH_TOKEN`, `ZOHO_DESK_ORG_ID`, `ZOHO_DESK_DEPARTMENT_ID`; optional `POSTHOG_API_HOST`, `ZOHO_DESK_DATA_CENTER` |
| Retention proof | `AXIOM_API_TOKEN`, `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`; optional `AXIOM_LOG_DATASET`, `AXIOM_ORG_ID`, `SENTRY_API_HOST` |
| Stripe and archive cleanup | Existing Stripe credentials, `DB_BACKUPS_R2_BUCKET`, `METRIC_STREAM_R2_BUCKET`, and the R2 credentials above |
| Replay and CDC proof | `REDPANDA_BROKERS`, `METRIC_STREAM_TOPIC`, ClickHouse credentials, and the PeerDB/SeaweedFS staging stack configuration |

Credential requirements:

- Stripe erasure combines the snapshotted billing identifiers, every recorded
  Stripe external effect, and an exhaustive customer-list scan for an exact
  `metadata.userId` match. The scan makes a customer discoverable even if the
  server stops after Stripe creates it but before local ownership persistence
  commits. Replay verification performs cleanup and then a second exhaustive
  scan that must delete or cancel nothing. Stripe documents cursor pagination
  for customer listing at <https://docs.stripe.com/api/customers/list>.
- Sign in with Apple revocation accepts only Apple's documented success
  response; a `400` OAuth error is not proof that the matching authorization
  was revoked. Apple documents `200` for both newly revoked and previously
  invalid tokens:
  <https://developer.apple.com/documentation/signinwithapplerestapi/revoke-tokens>.
- Strava grants are revoked through the idempotent `POST /oauth/revoke`
  endpoint with app HTTP Basic authentication. Strava documents that a
  successful request returns `200` whether or not the token was found and
  revokes associated access and refresh tokens:
  <https://developers.strava.com/docs/authentication/#deauthorization>.
- The Brevo key must authorize transactional-log deletion and process/status
  reads: <https://developers.brevo.com/reference/delete-an-smtp-transactional-log>.
- The PostHog personal API key must authorize person lookup, bulk deletion, and
  deletion-status reads for `POSTHOG_PROJECT_ID`:
  <https://posthog.com/docs/api/persons>.
- The Zoho refresh token must have
  `Desk.tickets.CREATE,Desk.contacts.CREATE,Desk.search.READ,Desk.tickets.READ,Desk.tickets.DELETE,Desk.recyclebin.READ,Desk.recyclebin.UPDATE`.
  Ticket search discovers legacy tickets by the exact server-generated user-ID
  footer, ticket deletion moves them to the Recycle Bin, and Recycle Bin
  deletion permanently removes the exact IDs:
  [ticket search](https://desk.zoho.com/DeskAPIDocument#Search_SearchTickets),
  [ticket deletion](https://desk.zoho.com/DeskAPIDocument#Tickets_DeleteTickets),
  [permanent deletion](https://desk.zoho.com/DeskAPIDocument#RecycleBin_DeleteresourcesfromRecycleBin).
  Because an access-token refresh preserves the refresh token's
  [same set of scopes](https://www.zoho.com/accounts/protocol/oauth/devices/refresh-access-token.html),
  regenerate `ZOHO_DESK_REFRESH_TOKEN` with the full set and update Infisical
  before rollout.
- Both Axiom datasets, `dofek-logs` (or the `AXIOM_LOG_DATASET` override) and
  `dofek-traces`, and the Sentry organization must retain events for at most 29
  days. The [processor verifier](../src/account-erasure/processor-retention.ts)
  checks each dataset; a 30-day setting fails closed because it leaves no time
  to verify and retry before the public deadline.
- The Axiom token must read retention configuration for both datasets:
  <https://axiom.co/docs/restapi/endpoints/getDataset>.
- The Sentry token must have `org:read` so the coordinator can read the
  organization's `dataRetention` value:
  <https://docs.sentry.io/api/organizations/retrieve-an-organization/>.
- The R2 credentials must have object read/write/list access to the account
  erasure ledger, database backup, metric archive, import, and export buckets
  used by the workflow:
  <https://developers.cloudflare.com/r2/api/tokens/#permissions>.

Before a production rollout:

1. Apply the Terraform changes that create the ledger bucket and lock
   `account-erasure/v1/` objects indefinitely. Do not configure lifecycle
   deletion for this prefix. Cloudflare bucket locks prevent deletion and
   overwriting indefinitely, apply to existing and new objects, and take
   precedence over lifecycle deletion. The provider exposes them through
   `cloudflare_r2_bucket_lock`:
   [R2 bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/),
   [Terraform resource](https://developers.cloudflare.com/api/terraform/resources/r2/subresources/buckets/subresources/locks/).
2. Confirm `dofek-db-backups` expires objects after 21 days and aborts
   incomplete multipart uploads after one day.
3. Confirm `account-erasure-staging/` in the metric archive expires after one
   day.
4. Confirm the unversioned PeerDB staging bucket `peerdbbucket` (SeaweedFS S3
   API on `peerdb-minio`) has the enabled
   `peerdb-transient-stage-retention` one-day rule with an empty prefix, no
   `And`, tag, object-size, or legacy-prefix restriction, and
   `AbortIncompleteMultipartUpload.DaysAfterInitiation=1` for incomplete
   multipart uploads. That lifecycle rule expires completed objects and aborts
   stale multipart uploads; Dofek lists both objects and multipart uploads
   before verification. S3 documents that an empty filter applies globally and
   that every other filter form narrows the matching objects:
   [S3 lifecycle filters](https://docs.aws.amazon.com/AmazonS3/latest/API/API_LifecycleRuleFilter.html),
   [AbortIncompleteMultipartUpload](https://docs.aws.amazon.com/AmazonS3/latest/API/API_AbortIncompleteMultipartUpload.html),
   [SeaweedFS S3 API](https://github.com/seaweedfs/seaweedfs/wiki/Amazon-S3-API).
5. Run the deploy environment validator and refuse rollout if any prerequisite
   is empty or inaccessible.
6. Confirm the web and worker startup gates can read and reconcile the R2
   restore ledger before accepting traffic or jobs.

See [deploy/README.md](../deploy/README.md) for the production rollout sequence,
[clickhouse-cdc-health-runbook.md](clickhouse-cdc-health-runbook.md) for PeerDB
health, and
[metric-stream-redpanda-r2-runbook.md](metric-stream-redpanda-r2-runbook.md)
for the replay archive.

## Monitor A Request

Use the request ID, not an email or status token, in operator tooling.

```sql
SELECT
  id,
  status,
  current_phase,
  requested_at,
  replay_retained_until,
  completion_deadline,
  retry_at,
  failure_count,
  pii_scrubbed_at,
  completed_at,
  updated_at
FROM fitness.account_erasure_request
WHERE id = '<request UUID>'::uuid;
```

Inspect checkpoint timing without copying the JSON `details` into a ticket:

```sql
SELECT phase, completed_at
FROM fitness.account_erasure_checkpoint
WHERE request_id = '<request UUID>'::uuid
ORDER BY completed_at, phase;
```

Inspect durable dispatch:

```sql
SELECT request_id, status, created_at, dispatched_at
FROM fitness.account_erasure_outbox
WHERE request_id = '<request UUID>'::uuid;
```

Interpretation:

- `pending` outbox rows are polled in bounded batches every five seconds.
- `dispatched` with no request progress means inspect the `account-erasure`
  BullMQ worker and Redis first.
- A future `retry_at` is expected for `waiting_replay`, `waiting_retention`, and
  retryable `failed` requests.
- `failure_count` increasing with the same `current_phase` identifies a
  persistent dependency failure.
- Any non-completed request at or beyond `completion_deadline` is an incident.
  The dispatcher records the miss, emits a Sentry error, and continues retries.

Search Axiom and Sentry by the request ID and the source/tag prefixes
`account-erasure-outbox`, `accountErasureStep`, and the worker event. Do not
search by or paste raw email addresses, provider credentials, encrypted
snapshots, `last_error`, checkpoint `details`, or status tokens into shared
incident channels.

## Stock physical maintenance acknowledgement

Day-29 `retention_verification` requires an operator-recorded
`stock_physical_maintenance_ack` in
`fitness.account_erasure_request.phase_progress -> 'retention_verification'`.
The worker reads that JSON only; it never invents the ack from TTL. There is no
bulk CLI — use the existing production `psql` path against the live database
(same tooling as [Monitor A Request](#monitor-a-request)). Do not run these
statements from agent sandboxes; an on-call operator executes them.

Operator attestation (not automation):

- Complete stock Pulsar/BookKeeper maintenance for the attested cutoff using
  existing administration tools only: namespace retention / message TTL /
  `producer_request_hold` backlog policy checks, the Q15 lifecycle sequence, and
  complete inventories documented in the Pulsar runbook. Apache documents
  namespace retention and TTL under
  [Message retention and expiry](https://pulsar.apache.org/docs/4.0.x/cookbooks-retention-expiry/).
- `verifiedCutoffAt` is the latest instant the operator’s completed stock
  Q15+inventory run covers. It must be ≥ durable `ingest_fence.completed_at`
  (so the fence is inside the covered window) and ≤ `verifiedAt` ≤ `now()`.
  Do **not** set the cutoff by copying the fence timestamp alone or by waiting
  for TTL/message expiry — TTL never satisfies this gate.
- Transport cutover itself remains a separate unapproved maintenance gate; see
  [Native transport cutover gate](#native-transport-cutover-gate). Do not treat
  a maintenance ack as cutover approval.
- Do not overwrite an existing `stock_physical_maintenance_ack`. If a prior ack
  was wrong, correct operationally outside this write (new request / explicit
  incident handling) rather than silently replacing attestation.
- An archive group timeout or process abort leaves remote PUT outcome ambiguous.
  Abort does **not** prove the object was cancelled at the store. Treat that as
  an incident: require a successful retry or object verification before recording
  this ack. There is no durable uncertainty store — operator verification only.

Transactional write + readback (substitute bracketed values). All eligibility
checks are enforced in SQL under the row lock — prose alone is insufficient:

```sql
BEGIN;

-- Bind operator-attested coverage and attestation times (timestamptz with offset).
-- verified_cutoff_at = latest instant covered by completed stock Q15+inventories.
-- verified_at = operator attestation time (usually now()).
SELECT
  request.id,
  request.status,
  request.current_phase,
  request.lease_owner,
  request.lease_expires_at,
  request.pii_scrubbed_at,
  request.phase_progress -> 'retention_verification' AS existing_ack,
  fence.completed_at AS ingest_fence_completed_at,
  scrub.completed_at AS request_pii_scrub_completed_at
FROM fitness.account_erasure_request AS request
LEFT JOIN fitness.account_erasure_checkpoint AS fence
  ON fence.request_id = request.id AND fence.phase = 'ingest_fence'
LEFT JOIN fitness.account_erasure_checkpoint AS scrub
  ON scrub.request_id = request.id AND scrub.phase = 'request_pii_scrub'
WHERE request.id = '<request UUID>'::uuid
FOR UPDATE OF request;
-- Expect status = waiting_retention and current_phase = processor_log_backup_retention.

UPDATE fitness.account_erasure_request AS request
SET
  phase_progress = jsonb_set(
    request.phase_progress,
    '{retention_verification}',
    jsonb_build_object(
      'kind', 'stock_physical_maintenance_ack',
      'runId', '<operator run id>',
      'operator', '<operator identity>',
      'verifiedAt', '<verified_at timestamptz with offset>'::text,
      'verifiedCutoffAt', '<verified_cutoff_at timestamptz with offset>'::text,
      'runbookRevision', '<docs/pulsar-remaining-work.md revision or commit>'
    ),
    true
  ),
  updated_at = now()
FROM fitness.account_erasure_checkpoint AS fence
JOIN fitness.account_erasure_checkpoint AS scrub
  ON scrub.request_id = fence.request_id
 AND scrub.phase = 'request_pii_scrub'
WHERE request.id = '<request UUID>'::uuid
  AND fence.request_id = request.id
  AND fence.phase = 'ingest_fence'
  AND request.status = 'waiting_retention'
  -- markAccountErasureWaiting(..., 'retention') sets this phase label.
  AND request.current_phase = 'processor_log_backup_retention'
  AND request.pii_scrubbed_at IS NOT NULL
  AND scrub.completed_at IS NOT NULL
  AND (request.lease_expires_at IS NULL OR request.lease_expires_at <= now())
  AND (
    request.phase_progress -> 'retention_verification' IS NULL
    OR request.phase_progress -> 'retention_verification' ->> 'kind'
         IS DISTINCT FROM 'stock_physical_maintenance_ack'
  )
  AND fence.completed_at <= '<verified_cutoff_at timestamptz with offset>'::timestamptz
  AND '<verified_cutoff_at timestamptz with offset>'::timestamptz
        <= '<verified_at timestamptz with offset>'::timestamptz
  AND '<verified_at timestamptz with offset>'::timestamptz <= now()
RETURNING request.phase_progress -> 'retention_verification' AS recorded_ack;

-- Expect exactly one returned row whose recorded_ack matches the attestation.
-- Otherwise ROLLBACK. On success:
COMMIT;
```

False-completion condition preserved: zero rows updated means the worker still
sees a missing/invalid ack and cannot complete `retention_verification`. After a
successful commit, allow the existing account-erasure worker to advance; it
re-validates ordering against durable `ingest_fence.completed_at` and summarizes
the ack into the phase checkpoint. Processor/backup checks are not a substitute
for this attestation.

## Native transport cutover gate

One-time operator prerequisite before an **approved** native transport cutover.
This is not steady-state deploy behavior, not a CLI, and not a workflow step.
Cutover remains an unapproved maintenance gate until executed under a concrete
approved cutover decision. Stock `psql` only (`ON_ERROR_STOP=1`); fail closed on
any non-completed `fitness.account_erasure_request` row.

```sql
-- psql -v ON_ERROR_STOP=1
BEGIN;

DO $$
DECLARE
  open_count bigint;
BEGIN
  SELECT count(*) INTO open_count
  FROM fitness.account_erasure_request
  WHERE status <> 'completed';

  IF open_count <> 0 THEN
    RAISE EXCEPTION
      'native transport cutover blocked: % non-completed account_erasure_request row(s)',
      open_count;
  END IF;
END $$;

-- Readback: expect open_count = 0.
SELECT count(*) AS open_count
FROM fitness.account_erasure_request
WHERE status <> 'completed';

COMMIT;
```

Interpretation:

- Non-zero `open_count` or a raised exception blocks cutover. Resolve or complete
  every open request first; do not bypass with a custom parser or helper.
- Zero `open_count` after the `DO` block is the only stock pass signal for this
  gate. Deploy/check callers may invoke the same SQL; they must not invent a
  softer gate.
- Passing this gate does not by itself ship cutover. Merge/deploy remains blocked
  until the concrete approved cutover decision is recorded outside this section.

## Triage By Phase

| Current phase | First evidence to collect | Canonical recovery |
|---------------|---------------------------|--------------------|
| `ingest_fence` | ClickHouse connectivity and fence-table writes; exact first fatal worker log | Restore ClickHouse connectivity or schema, then allow retry. Do not bypass the fence. |
| `stripe_erasure` / verification | Stripe response status, exhaustive customer-list pagination, and the zero-change proof pass | Correct Stripe credentials or API access, then retry the same phase. Treat already-absent resources as idempotent success; never bypass a non-advancing cursor, page safety limit, or non-empty proof pass. |
| `work_purge` / `work_verification` | BullMQ active jobs, Redis key/stream types, persisted job files, import/export objects | Stop the attributable active work or correct malformed managed state, then retry. Do not manually delete unrelated Redis keys. |
| `consumer_drain` / verification | Native ingest checkpoint `streams[].fence` (`lastMessageId` or empty), subscription `markDeletePosition` cursors from broker internal stats, and subscription names owned by the request | Restore the metric-stream consumers (archive + analytics delivery), correct any topic/subscription drift, and let contiguous native ACK (`markDelete`) cross each captured fence. Do not treat message TTL / namespace retention expiry as drain completion — Pulsar documents retention separately from consumer acknowledgement at <https://pulsar.apache.org/docs/4.0.x/cookbooks-retention-expiry/>. |
| `remote_revocation` / verification | Provider-specific disposition and first HTTP failure | Correct the provider credential or endpoint. Keep the encrypted snapshot until verification succeeds. |
| `processor_erasure` / verification | Brevo process status, PostHog deletion status, and Zoho ticket deletion result | Restore processor API access and retry. Never discard a credential merely to advance the phase. |
| `postgres_erasure` / `postgres_profile_delete` | PostgreSQL transaction error and exhaustive ownership assertion | Repair the schema/query cause and retry. Never issue broad ad-hoc deletes or clear `user_id` manually. |
| `peerdb_drain_verification` | Captured WAL LSN, PeerDB mirror position, SeaweedFS S3 lifecycle/versioning/object/upload checks | Restore CDC or staging retention, then let the proof rerun. Follow the CDC health runbook for slot or mirror failures. |
| `clickhouse_initial` / verification | Mutation status, failed part/reason, and attributable-row counts across the managed table allowlist | Fix the mutation/schema issue and wait for physical deletion. Do not treat an accepted mutation as completed. |
| `archive_initial` / verification | R2 object key, conditional-write result, and persisted last-key progress | Resolve R2 access or concurrent-write conflicts and resume. The verifier performs another full sweep from the beginning. |
| `request_pii_scrub` | Database transaction failure and remaining ownership assertion | Repair the direct cause. Do not manually remove the encrypted snapshot before all preceding verification completes. Scrub nulls checkpoint `details` except non-identifying retention / Kafka-TS inputs: PeerDB `stagingBoundary.cutoff`, `ingest_fence.highWatermarks`, and `consumer_drain.quarantineHighWatermarks`, each projected to `{topic,partition,low,offset}` only (nested identifiers stripped). Quarantine topics use `{source}.quarantine.v1`; main-log TS absence needs ingest HWM, not quarantine alone. |
| `retention_verification` | Stock `phase_progress.retention_verification` ack present and ordered; Axiom/Sentry retention response; database-backup lifecycle; objects at or before `pii_scrubbed_at` | Record or correct the stock physical ack via [Stock physical maintenance acknowledgement](#stock-physical-maintenance-acknowledgement); correct processor/backup retention; retry. Never mark complete while the ack or other proof remains unavailable. |

For ClickHouse mutations, use `system.mutations` to distinguish queued work from
a physical failure:

```sql
SELECT
  database,
  table,
  mutation_id,
  command,
  is_done,
  latest_fail_reason
FROM system.mutations
WHERE database IN ('ingest', 'analytics')
ORDER BY create_time DESC;
```

The physical part proof starts with active parts that currently match the
account predicate and follows their `MergeParts` and `MutatePart` ancestry
through `system.part_log`. It does not treat unrelated inactive parts as
account data: ClickHouse keeps inactive parts in `system.parts` while they are
awaiting cleanup, and the part log records the source parts for merge and
mutation events. See [system.parts](https://clickhouse.com/docs/reference/system-tables/parts)
and [system.part_log](https://clickhouse.com/docs/reference/system-tables/part_log).

The ClickHouse proof enumerates every table in the managed databases before it
classifies engines. MergeTree-family engines are physically erased; `View`,
`MaterializedView`, and `Null` are explicitly treated as engines without their
own retained rows; any other engine fails the proof closed. This prevents a
newly introduced physical engine from being silently excluded by the discovery
query. ClickHouse documents table engines as the layer that controls where and
how table data is stored:
<https://clickhouse.com/docs/engines/table-engines>. The explicit exceptions
follow ClickHouse's documented semantics for
[logical views](https://clickhouse.com/docs/engines/table-engines/special/view),
[incremental materialized views with target tables](https://clickhouse.com/docs/materialized-view/incremental-materialized-view),
and the row-discarding
[Null engine](https://clickhouse.com/docs/engines/table-engines/special/null).

The physical proof also requires `system.detached_parts` to be empty for every
targeted personal-data table before mutation and while waiting for old parts to
disappear. A detached part is not visible to normal table reads but remains on
storage and can be attached again, so its presence is a hard failure rather
than a row-count success. Inspect it without querying personal rows:

```sql
SELECT database, table, name, reason, bytes_on_disk, modification_time
FROM system.detached_parts
WHERE database IN ('analytics', 'ingest', 'postgres_fitness')
ORDER BY database, table, name;
```

ClickHouse documents both the detached-parts inventory and the fact that
`ATTACH PART` can restore a detached part:
[system.detached_parts](https://clickhouse.com/docs/reference/system-tables/detached_parts),
[DETACH/ATTACH PART](https://clickhouse.com/docs/reference/statements/alter/partition).
Resolve the provenance of every detached part and remove it through an approved
data-recovery or deletion operation; do not bypass this proof.

PeerDB stages ClickHouse loads through S3-compatible storage; PeerDB documents
that architecture and its ClickHouse connector here:
<https://docs.peerdb.io/destinations/clickhouse>.
The staging proof requires bucket versioning to be disabled and the exact
global one-day lifecycle rule above. It exhaustively follows both object
continuation tokens and the multipart `(KeyMarker, UploadIdMarker)` pair. A
missing or repeated next cursor fails immediately, before another request can
repeat the same page. AWS documents both pagination contracts:
[ListObjectsV2](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html),
[ListMultipartUploads](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListMultipartUploads.html).
For each erasure, the coordinator durably records which ClickHouse CDC writers
it owns before requesting a pause, waits until every writer reports the fully
settled `STATUS_PAUSED` state, and repeatedly verifies that the complete writer
set remains unchanged. While all writers are paused, it writes and reads back a
zero-byte marker, exhaustively inventories completed objects and multipart
uploads twice, and requires identical object/upload identities and pagination
cursors in both passes. The persisted storage cutoff is the latest of the
marker `LastModified`, every observed object `LastModified`, and every observed
multipart `Initiated` value. Writers resume only after that cutoff is durable.
The day-29 proof rejects every object or upload timestamped at or before the
cutoff, including equality. This closes the transition in which an upload
started before the pause but became a completed object after the marker.

## Backup And Restore Behavior

The database-backup bucket has a 21-day lifecycle, and the deploy workflow also
runs a bounded, verified sweep. The final phase refuses completion while an
object from at or before `pii_scrubbed_at` remains. Backup age is the snapshot
start embedded in the managed object key, never the object's `LastModified`
value or a multipart upload's initiation time. Databasus creates its
`Health-YYYYMMDD-HHMMSS-<uuid>` name from UTC before starting the backup and
writes a `.metadata` companion; its chunked S3 format adds `.partNNNNNN`
objects and a `.parts` manifest:
[Databasus v3.32.1 filename source](https://github.com/databasus/databasus/blob/v3.32.1/backend/internal/features/backups/backups/core/model.go#L50-L58),
[Databasus v3.32.1 scheduler source](https://github.com/databasus/databasus/blob/v3.32.1/backend/internal/features/backups/backups/backuping/scheduler.go#L190-L228),
[Databasus v3.32.1 metadata source](https://github.com/databasus/databasus/blob/v3.32.1/backend/internal/features/backups/backups/backuping/backuper.go#L299-L327),
[Databasus chunked S3 format](https://github.com/databasus/databasus/blob/89e32a94c4c33b0a050d3e36835514bc9d644378/backend/internal/features/storages/models/s3/model.go#L96-L103).
The only additional managed form is the known operator snapshot
`manual/health-pre-metric-stream-drop-YYYYMMDDTHHMMSSZ.dump`. An unknown or
calendar-invalid key fails the proof before any deletion.

Each proof enumerates every completed-object page and every multipart-upload
page using the `(KeyMarker, UploadIdMarker)` pair, with bounded and
nonadvancing-cursor checks. It deletes only the exact qualifying object keys,
aborts only the exact qualifying `(key, upload ID)` pairs, then repeats both
listings until a clean verification pass accounts for objects or uploads that
appeared between passes. Account erasure uses the later of the 21-day cutoff
and `pii_scrubbed_at`; the ordinary deploy sweep remains retention-only. AWS
documents the multipart marker pair and exact abort identity, while Cloudflare
documents R2's S3-compatible multipart operations:
[S3 ListMultipartUploads](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListMultipartUploads.html),
[S3 multipart overview](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html),
[R2 multipart uploads](https://developers.cloudflare.com/r2/objects/upload-objects/).

Cloudflare notes that R2 lifecycle deletion is asynchronous, which is why the
workflow lists and verifies objects instead of relying on policy configuration
alone:
<https://developers.cloudflare.com/r2/buckets/object-lifecycles/>.

When account erasure rewrites a mixed-user metric archive, the staged
multipart upload reuses the source object's `Content-Type`,
`Content-Encoding`, and every custom metadata entry. The conditional
`CopyObject` commit omits `x-amz-metadata-directive`, whose documented default
is `COPY`, so the rewritten canonical object keeps that metadata instead of
silently replacing it with hard-coded gzip headers:
[CreateMultipartUpload](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CreateMultipartUpload.html),
[CopyObject metadata directive](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CopyObject.html#API_CopyObject_RequestSyntax).

Metric archive scanning admits at most 900,000 payload bytes per line, excluding
the LF delimiter. It validates UTF-8 and the event schema before replacement,
and requires successful gzip EOF on both the scan and rewrite reads. Surviving
records retain their original bytes, including CR characters, whitespace and
whether the final record ended with LF. Legacy and native object keys use the
same bounded reader; see the [eraser](../src/account-erasure/archive-erasure.ts),
[line reader](../src/metric-stream/archive-lines.ts) and
[real S3 tests](../src/account-erasure/archive-erasure.integration.test.ts).
The scan places decompression and record consumption inside one awaited Node
[stream pipeline](https://nodejs.org/api/stream.html#streampipelinesource-transforms-destination-options)
so failures propagate before it returns a count.

A [November 5 retained measurement](pulsar-foundation-qualification.md#november-5-retained-archive-line-size-measurement)
of three independently verified manual-offload objects covered 247,242 lines;
the largest payload was 902 bytes. This sample
is comfortably below the limit, but it does not qualify every line in the
complete offload or the older archive inventory. An oversized
legacy record is an explicit residual risk: it blocks that object's erasure.
This is an erasure rewrite boundary, not a change to legacy storage. Existing
objects retain their flat keys and gzip JSONL format; erasure replaces only
objects containing matching records, at the same canonical keys.
Keep the original object and ETag, preserve the failed checkpoint, and open an
erasure incident. A reviewed bounded repair must account for the complete
record and pass full-EOF validation, the conditional replacement and read-back
before retry. Never skip or truncate the record, raise the limit merely to
suppress the failure, or mark the request complete. A failed source stream or
corrupt gzip also leaves the object checkpoint incomplete.

Confirmation writes an encrypted, immutable deletion-ledger intent to
`dofek-account-erasure-ledger` before the request can be considered durable.
The `account-erasure/v1/` prefix is locked indefinitely and has no lifecycle
deletion rule, so even credentials with object write access cannot overwrite or
delete an intent. Cloudflare documents that bucket locks can retain objects
indefinitely, apply to existing and new objects, and take precedence over
lifecycle deletion:
<https://developers.cloudflare.com/r2/buckets/bucket-locks/>.
After a database restore, web and worker startup enumerate that ledger and
recreate any missing active request before accepting traffic or work. Failure
to read, decrypt, validate, or reconcile the ledger is a startup failure.
Before an active request is excluded from recovery, startup fetches that
request's exact immutable intent by key ID, user hash, and request ID, verifies
the request timestamp, and compares the recovered status token with the stored
hash. It also rejects any retained ledger reference whose key ID is absent from
the configured keyring. These invariants are enforced by the
[restore reconciler](../src/account-erasure/restore-reconciliation.ts); a
database row and ledger object are never accepted merely because they refer to
the same user.
Each indefinitely retained sealed object is deliberately narrow: a random
deletion-request identifier and timestamp, a keyed pseudonymous account digest,
a key identifier, AES-GCM initialization/authentication values, and encrypted
status-capability bytes. It contains no raw account or provider identifier,
email address, health data, or provider credential. This R2 object is the
canonical immutable restore and deletion ledger that prevents a later database
rollback from forgetting an overdue or completed request. The pseudonymous
Postgres request row remains the live query and status record, not a second
completion ledger.

Key rotation for `ACCOUNT_ERASURE_LEDGER_KEYRING_JSON`:

1. Add a new 32-byte base64 key under a new key ID.
2. Change `activeKeyId` to the new ID while retaining every old key.
3. Deploy and verify both web and worker startup reconciliation.
4. Retain every old key indefinitely. An immutable ledger object cannot be
   re-encrypted in place, and removing a referenced key makes startup
   reconciliation fail closed.

Never overwrite or delete an intent object to resolve a conflict. A conditional
create conflict with different contents is evidence of corruption or an
identity/key-management incident.

## Incident Response

1. Record the request ID, status, phase, deadline, first fatal log line, and the
   exact failing command or API operation.
2. Verify logging and Sentry delivery before changing behavior.
3. Identify the causal dependency or data invariant. Do not add retries,
   timeouts, `continue-on-error`, manual checkpoint completion, or fence removal
   as a mitigation.
4. Repair the direct cause and observe the same request resume from its durable
   checkpoints.
5. Verify the user-visible public status remains accurate and the write fence
   still rejects auth and data writes.
6. If the deadline is missed, treat the request as unresolved even though
   automatic retries continue. Notify the user through the approved support
   channel without exposing internal errors.
7. Append the evidence, root cause, fix, validation, residual risk, and follow-up
   to [production-incident-baseline.md](production-incident-baseline.md).

## Validation

Run repository commands with Node 26. Database-backed tests use the workspace
Compose wrapper described in [testing.md](testing.md).

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm test:integration
pnpm --filter @dofek/web build
pnpm --filter @dofek/mobile test
```

Also validate:

- the account-erasure migration against a real PostgreSQL instance;
- direct, transitive, and orphan erasure against real PostgreSQL and
  ClickHouse;
- Redpanda high-watermark capture, consumer drain, and seven-day replay
  waiting;
- real SeaweedFS S3 lifecycle, object, and multipart-upload inspection;
- R2 archive conditional rewrite and backup sweep pagination;
- web and iOS cold restart, status-capability recovery, local purge, background
  cutoff, native module cleanup, and watch cleanup;
- Terraform formatting and validation;
- the production deploy environment with
  `pnpm tsx scripts/validate-deploy-env.ts <rendered-dotenv-path>`.

Do not use a production account as a validation fixture. A production deletion
request is irreversible even when its coordinator later reports a retryable
failure.

## Provider download artifacts

The work-purge and verification phases delete the user's complete
`provider-artifacts/<user-id>/` prefix in `IMPORT_R2_BUCKET`, including Garmin
FIT files retained for retry. Provider-data deletion removes only that user's
provider prefix. The shared provider execution fence serializes processing and
deletion; current authorization and deletion-generation checks reject stale
work. See [artifact storage](../src/provider-artifact-storage.ts),
[account work purge](../src/jobs/account-erasure-work-purger.ts), and
[provider deletion](../src/jobs/process-provider-data-deletion-job.ts).

## Activity image originals

The work-purge phase includes the activity-images queue and deletes the user's
complete images/<user-id>/ prefix in the private activity media bucket selected
by ACTIVITY_MEDIA_R2_BUCKET. The sweep paginates and verifies absence before
acknowledgement; database ownership discovery includes all activity-image tables.
Existing account-erasure work barriers prevent a late acquisition from recreating
objects. Restored account rows are subject to the existing restore reconciliation
before media work resumes. See [activity image operations](activity-images.md)
and [R2 object operations](https://developers.cloudflare.com/r2/api/s3/api/).
