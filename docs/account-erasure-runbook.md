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
| Immediate safety | `ingest_fence`, `stripe_erasure`, `work_purge`, `consumer_drain` | ClickHouse ingest is fenced; Stripe deletion finished; BullMQ/Redis/files/objects are quiescent; captured Redpanda offsets are consumed; the quarantine high-watermark boundary is captured only after both source consumer groups drain. Stripe's customer-delete behavior is documented at <https://docs.stripe.com/api/customers/delete>. |
| Initial erasure | `remote_revocation`, `processor_erasure`, `postgres_erasure`, `clickhouse_initial`, `archive_initial` | Remote credentials are revoked or proven already absent; processor deletions are queued; attributable Postgres and ClickHouse data is removed; mixed-user R2 archives are conditionally rewritten. Cloudflare documents R2 conditional S3 writes at <https://developers.cloudflare.com/r2/api/s3/api/>. |
| Replay verification | `work_verification`, `consumer_drain_verification`, `stripe_erasure_verification`, `remote_revocation_verification`, `processor_erasure_verification`, `postgres_profile_delete`, `peerdb_drain_verification`, `clickhouse_verification`, `archive_verification`, `request_pii_scrub` | No late work or replay can recreate data; Stripe and other remote processors re-acknowledge deletion; PeerDB has crossed the captured PostgreSQL WAL position; ClickHouse and R2 pass a second sweep; live request PII is removed. |
| Retention verification | `retention_verification` | At day 29, every quarantine low watermark has crossed the persisted post-drain high watermark; the quarantine topic still has exact `delete`, seven-day, and 1-GiB retention bounds; Axiom and Sentry retention are at most 29 days; database backups are at most 21 days old and none from at or before the PII-scrub boundary remain. Redpanda documents that `cleanup.policy=delete` applies the `retention.ms` and `retention.bytes` limits at <https://docs.redpanda.com/streaming/current/reference/properties/topic-properties/>. |

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
| Replay and CDC proof | `REDPANDA_BROKERS`, `METRIC_STREAM_TOPIC`, ClickHouse credentials, and the PeerDB/MinIO stack configuration |
| Shared Slack installations | Every stored Slack bot token must still authenticate for its recorded workspace and carry `users:read`; the deploy backfill verifies both before account-erasure-capable services roll out |

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
- The Axiom dataset and Sentry organization must retain events for at most 29
  days. A 30-day setting fails closed because it leaves no time to verify and
  retry before the public deadline.
- The Axiom token must read dataset retention configuration:
  <https://axiom.co/docs/restapi/endpoints/updateDataset>.
- The Sentry token must have `org:read` so the coordinator can read the
  organization's `dataRetention` value:
  <https://docs.sentry.io/api/organizations/retrieve-an-organization/>.
- The R2 credentials must have object read/write/list access to the account
  erasure ledger, database backup, metric archive, import, and export buckets
  used by the workflow:
  <https://developers.cloudflare.com/r2/api/tokens/#permissions>.
- Slack's `auth.test` method must return the workspace recorded with each bot
  token, and `users.info` must remain available through the existing
  `users:read` scope. A successful lookup is accepted only when the returned
  user ID matches and the user object names the installed workspace; visibility
  of a foreign Slack Connect user is not membership proof. Slack documents the
  token identity response, the method scope, and the workspace-qualified user
  fields:
  [auth.test](https://docs.slack.dev/reference/methods/auth.test/),
  [users.info](https://docs.slack.dev/reference/methods/users.info/),
  [user object](https://docs.slack.dev/reference/objects/user-object/).

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
4. Confirm the unversioned PeerDB MinIO `peerdbbucket` has the enabled
   `peerdb-transient-stage-retention` one-day rule with an empty prefix and no
   `And`, tag, object-size, or legacy-prefix restriction. That lifecycle rule
   expires completed objects. Confirm the MinIO server separately has
   `MINIO_API_STALE_UPLOADS_EXPIRY=24h` and
   `MINIO_API_STALE_UPLOADS_CLEANUP_INTERVAL=15m` for incomplete multipart
   uploads; MinIO documents that server-wide stale-upload cleanup as distinct
   from bucket lifecycle actions. Dofek lists both objects and multipart uploads
   before verification. S3 documents that an empty filter applies globally and
   that every other filter form narrows the matching objects:
   [S3 lifecycle filters](https://docs.aws.amazon.com/AmazonS3/latest/API/API_LifecycleRuleFilter.html),
   [MinIO lifecycle rules](https://min.io/docs/minio/linux/reference/minio-mc/mc-ilm-rule-add.html),
   [MinIO stale multipart-upload settings](https://docs.min.io/aistor/reference/aistor-server/settings/core/#stale-multipart-upload-expiry).
5. Run the deploy environment validator and refuse rollout if any prerequisite
   is empty or inaccessible.
6. Confirm the web and worker startup gates can read and reconcile the R2
   restore ledger before accepting traffic or jobs.
7. Let the post-migration Slack membership one-shot complete before the first
   account-erasure-capable web or worker rollout. It writes installer
   relationships recorded during OAuth and non-installer relationships proven
   by exact `users.info` workspace membership in one transaction. It must stop
   the rollout on a missing `users:read` scope, an invalid or wrong-workspace
   token, a concurrent database change, or an ambiguous unqualified legacy
   identity. For an ambiguity, do not infer from the Slack user ID: obtain an
   account-owner-confirmed mapping containing the Dofek user, Slack workspace,
   and Slack user, record it through the normal team-scoped membership path,
   and rerun the one-shot.

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

## Triage By Phase

| Current phase | First evidence to collect | Canonical recovery |
|---------------|---------------------------|--------------------|
| `ingest_fence` | ClickHouse connectivity and fence-table writes; exact first fatal worker log | Restore ClickHouse connectivity or schema, then allow retry. Do not bypass the fence. |
| `stripe_erasure` / verification | Stripe response status, exhaustive customer-list pagination, and the zero-change proof pass | Correct Stripe credentials or API access, then retry the same phase. Treat already-absent resources as idempotent success; never bypass a non-advancing cursor, page safety limit, or non-empty proof pass. |
| `work_purge` / `work_verification` | BullMQ active jobs, Redis key/stream types, persisted job files, import/export objects | Stop the attributable active work or correct malformed managed state, then retry. Do not manually delete unrelated Redis keys. |
| `consumer_drain` / verification | Captured source and quarantine partition offsets, current consumer offsets, and exact quarantine topic configuration | Restore the metric-stream consumers and quarantine writer, correct any topic-policy drift, and let the consumers cross the captured source high-water marks. Follow the Redpanda/R2 runbook if replay is involved. |
| `remote_revocation` / verification | Provider-specific disposition and first HTTP failure | Correct the provider credential or endpoint. Keep the encrypted snapshot until verification succeeds. |
| `processor_erasure` / verification | Brevo process status, PostHog deletion status, and Zoho ticket deletion result | Restore processor API access and retry. Never discard a credential merely to advance the phase. |
| `postgres_erasure` / `postgres_profile_delete` | PostgreSQL transaction error and exhaustive ownership assertion | Repair the schema/query cause and retry. Never issue broad ad-hoc deletes or clear `user_id` manually. |
| `peerdb_drain_verification` | Captured WAL LSN, PeerDB mirror position, MinIO lifecycle/versioning/object/upload checks | Restore CDC or staging retention, then let the proof rerun. Follow the CDC health runbook for slot or mirror failures. |
| `clickhouse_initial` / verification | Mutation status, failed part/reason, and attributable-row counts across the managed table allowlist | Fix the mutation/schema issue and wait for physical deletion. Do not treat an accepted mutation as completed. |
| `archive_initial` / verification | R2 object key, conditional-write result, and persisted last-key progress | Resolve R2 access or concurrent-write conflicts and resume. The verifier performs another full sweep from the beginning. |
| `request_pii_scrub` | Database transaction failure and remaining ownership assertion | Repair the direct cause. Do not manually remove the encrypted snapshot before all preceding verification completes. |
| `retention_verification` | Quarantine topic configuration and low watermarks, Axiom/Sentry retention response, database-backup lifecycle, and objects at or before `pii_scrubbed_at` | Correct topic-policy drift, retention, or credentials; sweep expired backups; and retry. Never mark complete while any pre-boundary quarantine payload or other proof remains unavailable. |

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
- real MinIO lifecycle, object, and multipart-upload inspection;
- R2 archive conditional rewrite and backup sweep pagination;
- web and iOS cold restart, status-capability recovery, local purge, background
  cutoff, native module cleanup, and watch cleanup;
- Terraform formatting and validation;
- the production deploy environment with
  `pnpm tsx scripts/validate-deploy-env.ts <rendered-dotenv-path>`.

Do not use a production account as a validation fixture. A production deletion
request is irreversible even when its coordinator later reports a retryable
failure.
