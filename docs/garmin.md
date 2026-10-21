# Garmin

## Official connection and delivery

Dofek's Garmin integration uses the approved application's OAuth consent flow
and official push delivery. Connect or Reconnect from Garmin's Data Sources
page on web or mobile; Dofek does not request a Garmin password. New data arrives
automatically after the user syncs their Garmin device. Garmin has connection
and disconnect controls, while manual Sync is unavailable for this push-only
source. See the [OAuth implementation](../src/providers/garmin/oauth.ts),
[push provider](../src/providers/garmin/provider.ts), and Garmin's
[program overview](https://developer.garmin.com/gc-developer-program/overview/).

Reconnect replaces OAuth credentials for the same Garmin account while preserving
its registration. Dofek verifies the returned Garmin account ID before replacing
the connection. To connect a different Garmin account, disconnect the current
one first. Registration deletion is reserved for explicit Disconnect and account
erasure. Failed OAuth attempts, including first connections, preserve remote
consent for a later retry; failed reconnects also retain the existing local
connection. See the
[OAuth lifecycle](../src/providers/garmin/oauth.ts) and Garmin's
[authorized API catalog](https://developerportal.garmin.com/developer-programs/programs-docs).

The approved Dofek application has Starter Health and Activity access. Starter
delivery is push only, has limited capacity, and excludes historical API access;
check the application's current entitlement in the
[Developer Portal](https://developerportal.garmin.com/developer-programs/connect-developer-api)
and the [public tier comparison](https://developer.garmin.com/gc-developer-program/overview/).
Approval does not imply Enterprise history or unlimited capacity.

Existing `garmin` and `garmin-dump` records remain intact. Legacy private Garmin
tokens do not authorize the official app: those users must reconnect through
OAuth. Garmin account-export ZIP imports remain available for historical data;
they are separate from live delivery. See the
[authorization migration](../drizzle/0156_garmin_official_authorization.sql),
[account-export importer](../src/providers/garmin-dump.ts), and
[import flow](../src/jobs/garmin-dump-flow.ts).

## Supported incoming feeds

The [receiver schemas](../src/providers/garmin/payloads.ts) and
[provider dispatcher](../src/providers/garmin/provider.ts) define the supported
delivery surface. Consult the authorized
[Garmin documentation catalog](https://developerportal.garmin.com/developer-programs/programs-docs)
when configuring the app; confidential contracts are not reproduced here.

| Feed | Dofek handling |
|------|----------------|
| `dailies` | Raw daily values and timestamped heart-rate readings. |
| `sleeps` | Sleep sessions, stage records, and supplied sensor readings. |
| `hrv` | Provider-supplied nightly HRV. |
| `pulseox` | Timestamped oxygen-saturation readings. |
| `allDayRespiration` | Timestamped respiration readings. |
| `activities`, `manuallyUpdatedActivities` | Activity identity and summary revisions, preserving manual/import provenance. |
| `activityFiles` | Durable FIT download and existing FIT ingestion. |
| `userPermissionsChange`, `deregistrations` | Recheck current permissions or remove a revoked authorization. |

Only enabled, granted feeds are ingested. The
[Health mapper](../src/providers/garmin/health.ts) and
[activity mapper](../src/providers/garmin/activities.ts) retain source attribution;
provider-estimated calorie expenditure is not consumed. FIT data uses the
existing [FIT import routine](../src/jobs/process-fit-file-import-job.ts) and Garmin's
[FIT format](https://developer.garmin.com/fit/overview/).

## Operator configuration and release checks

Application secrets belong in Infisical: `GARMIN_CLIENT_ID`,
`GARMIN_CLIENT_SECRET`, and `GARMIN_WEBHOOK_SECRET`. All three production key
names were verified on 2026-10-21. Do not print their values. The receiver secret
must be at least 32 bytes; use a cryptographically random value. Configure the
OAuth redirect through the shared [OAuth callback](../src/auth/oauth.ts),
following the [production-secrets runbook](../deploy/README.md#production-secrets)
and [Infisical CLI guidance](https://infisical.com/docs/cli/overview).

Configure approved feeds to POST to
`https://dofek.fit/api/webhooks/garmin?token=<GARMIN_WEBHOOK_SECRET>`.
The query token is a receiver capability: keep the completed URL secret and
never paste it into logs, screenshots, tickets, or documentation. The
[receiver](../packages/server/src/routes/garmin-webhooks.ts) checks it before
parsing and durably queues accepted records before acknowledging delivery.
[HTTP/fetch tracing](../src/instrumentation.ts),
[Sentry hooks](../src/lib/sentry.ts), and the
[request logger](../packages/server/src/index.ts) redact credential query values.

Keep portal endpoints **On Hold** until production deployment and OAuth checks
pass. Garmin queues held notifications without sending them. Removing a hold
releases queued notifications for the entire application feed, so live delivery
checks require a controlled release ([Garmin delivery settings](https://developerportal.garmin.com/developer-programs/programs-docs)).
The migration has not yet been deployed as of 2026-10-21; application approval
and configured secrets alone do not establish live delivery. Follow
[deployment procedures](../deploy/README.md), then:

1. Confirm the migration ran, the web server and Garmin queue worker are
   healthy, and the required secrets and R2 bucket are configured. Queue
   registration is required even though scheduled polling is excluded. See
   [worker construction](../src/jobs/worker-queues.ts) and
   [queue configuration](../src/jobs/provider-queue-config.ts).
2. Verify Connect and Reconnect through official OAuth on web and mobile.
3. Remove the hold from the configured feeds for controlled validation and
   confirm the setting survives a portal reload. Sync a Garmin device and verify
   an authorized Health/Activity delivery.
4. Verify a FIT delivery reaches durable storage and canonical activity/sensor
   ingestion, and retry does not require another download once it is retained.
5. Verify permission changes, disconnect/revocation, and stale-event rejection;
   inspect telemetry using synthetic credentials to confirm redaction.
   Reconnect the test account after revocation checks. Return feeds to **On Hold**
   if validation fails; leave delivery enabled after all checks pass.

FIT artifacts use the existing `IMPORT_R2_BUCKET` (`dofek-imports` in the
deployment stack) and shared R2 credentials. Objects belong to the Dofek user
and provider under `provider-artifacts/{userId}/{providerId}/{sha256}.fit`;
the hash avoids putting a signed callback URL in an object key. Upload completes
before parsing. Failed parsing retains the object for retry, and local temporary
copies are removed. Provider-data deletion removes that provider's artifacts;
account erasure removes all of the user's artifacts. See
[artifact storage](../src/provider-artifact-storage.ts),
[provider deletion dependencies](../src/jobs/provider-data-deletion-dependencies.ts),
and [account-erasure purge](../src/jobs/account-erasure-work-purger.ts).

## Historical assessment: 2026-10-21, before the migration

The assessment below describes the private implementation at commit
[`585bfa7`](https://github.com/Asherlc/dofek/tree/585bfa7d2e9417bc77e9cef751a2ef5901fdbd7d).
Its repository links are pinned to that revision. It records the migration
rationale and retired behavior; use the sections above for current operation.

### Original research context

Research date: 2026-10-21. At the start of this assessment, Developer Program approval had been received while the integration still used private Garmin Connect endpoints. Field-level parity and delivery contracts were assessed through the authorized [documentation catalog](https://developerportal.garmin.com/developer-programs/programs-docs). This historical assessment contains no partner schemas.

### Program scope

Garmin now distinguishes Personal, Starter Business, and Enterprise Business
access. Their delivery and history allowances differ; approval alone does not
establish Enterprise entitlement. The
[public overview](https://developer.garmin.com/gc-developer-program/overview/)
and [Developer Portal overview](https://developerportal.garmin.com/developer-programs/connect-developer-api) are the current
sources for product availability and app limits.

| Access | Publicly advertised capabilities | Delivery, history, and capacity |
|--------|----------------------------------|---------------------------------|
| Personal | Own-account Activity JSON/FIT, Health, and Women's Health | Personal key/tokens; pull only. Not business authorization for multiple users. |
| Starter Business | Health, Activity JSON/FIT, Women's Health, Training, Courses | Push only; no historical data; limited capacity; check the portal for the application limit. |
| Enterprise Business | Starter APIs plus Golf options | Push or Ping/Pull; one month or more of history; unlimited users; technical support. Commercial terms depend on requirements. |

Health is broader than this repository's previous audit claimed. Garmin's
[public Health API description](https://developer.garmin.com/gc-developer-program/health-api/)
includes steps, intensity minutes, sleep, heart rate, stress, Pulse Ox, Body
Battery, body composition, respiration, and blood pressure. Body Battery and
stress are therefore not inherently private-API-only features. Device support,
permissions, exact fields, and sampling remain contract-verification questions.

Training and Courses publish content to Garmin Connect for compatible devices;
they are not a promise to expose every Garmin training-analysis score. Women's
Health covers menstrual and pregnancy information. Direct wearable streaming
is a separate Health SDK offering, rather than an automatic consequence of cloud
API approval. See the [program description](https://developer.garmin.com/gc-developer-program/),
[Women's Health API](https://developer.garmin.com/gc-developer-program/womens-health-api/),
and [Health SDK comparison](https://developer.garmin.com/health-sdk/).

### Program conditions

The assessment recorded application terms, pricing, attribution, and intended downstream use as contract-review questions. Consult the applicable agreement and authorized [documentation catalog](https://developerportal.garmin.com/developer-programs/programs-docs); no agreement wording is reproduced here.

The [public attribution guidelines](https://developer.garmin.com/downloads/brand/Garmin-Developer-API-Brand-Guidelines.pdf)
cover dashboards, detail screens, exports, and combined or derived analytics.
Review both clients and downstream data interfaces when scoping the migration.

### Current live ingestion

The [orchestrator](https://github.com/Asherlc/dofek/blob/585bfa7d2e9417bc77e9cef751a2ef5901fdbd7d/src/providers/garmin/sync-orchestrator.ts) imports the
following data. The replacement column identifies the product to validate,
not an assertion of verified field-for-field equivalence.

| Current input | Fields retained by the live path | Replacement to validate |
|---------------|----------------------------------|-------------------------|
| Activity list | External ID, type, name, start/end, device name, raw summary | Activity API identity and metadata; preserve existing activity associations. |
| Activity chart detail | Timestamped HR, power, cadence, speed, altitude, GPS, air temperature | Activity API FIT files through the existing FIT decoder; verify channel coverage and provenance. |
| Sleep | Session times, duration, stage totals, staging availability, stage timeline | Health API sleep payloads and revisions. |
| Daily summary | Steps, distance, SpO₂ average, floors, exercise minutes | Health API summaries and units. |
| Nightly HRV | Last-night average or last-night value, when a daily metrics row exists | Health API coverage, semantics, and missing-data handling. |
| Daily HR | Timestamped positive heart-rate samples | Health API sampling, time offsets, and revisions. |

The client exposes more methods than Dofek uses: Body Battery, training status
and readiness, VO₂ max, race predictions, hill/endurance scores, and separate
respiration/SpO₂ methods are library surface, not active orchestrator inputs.
The daily-summary parser returns no respiration value, and the orchestrator
does not persist its parsed resting HR. See the
[client methods](https://github.com/Asherlc/dofek/blob/585bfa7d2e9417bc77e9cef751a2ef5901fdbd7d/packages/garmin-connect/src/client.ts),
[parsers](https://github.com/Asherlc/dofek/blob/585bfa7d2e9417bc77e9cef751a2ef5901fdbd7d/packages/garmin-connect/src/parsing.ts), and
[actual writers](https://github.com/Asherlc/dofek/blob/585bfa7d2e9417bc77e9cef751a2ef5901fdbd7d/src/providers/garmin/sync-orchestrator.ts).

### Workarounds to retire

Replace the live integration with one official path once its required coverage
is validated. These are candidates for removal, not changes already made.
The current [auth router](https://github.com/Asherlc/dofek/blob/585bfa7d2e9417bc77e9cef751a2ef5901fdbd7d/packages/server/src/routers/garmin-auth.ts) uses
the password for sign-in and persists the returned token object; it does not
store the password. Official consent would also remove Dofek's handling of
Garmin login credentials in transit.

| Current mechanism | Evidence | Retirement condition |
|-------------------|----------|----------------------|
| Dofek collects Garmin email/password, emulates SSO cookies, parses HTML CSRF/title/ticket | [Web modal](https://github.com/Asherlc/dofek/blob/585bfa7d2e9417bc77e9cef751a2ef5901fdbd7d/packages/web/src/components/DataSourcesAuthModals.tsx), [mobile modal](https://github.com/Asherlc/dofek/blob/585bfa7d2e9417bc77e9cef751a2ef5901fdbd7d/packages/mobile/components/providers/auth-modals.tsx), [auth router](https://github.com/Asherlc/dofek/blob/585bfa7d2e9417bc77e9cef751a2ef5901fdbd7d/packages/server/src/routers/garmin-auth.ts), [client sign-in](https://github.com/Asherlc/dofek/blob/585bfa7d2e9417bc77e9cef751a2ef5901fdbd7d/packages/garmin-connect/src/client.ts#L82) | Official OAuth connection works on web and mobile. The current client explicitly rejects interactive MFA. |
| Public third-party S3 consumer credentials and Android/iOS app user agents | [Client constants and consumer loading](https://github.com/Asherlc/dofek/blob/585bfa7d2e9417bc77e9cef751a2ef5901fdbd7d/packages/garmin-connect/src/client.ts#L39) | Approved application credentials replace the emulated mobile identity. |
| Preauthorized OAuth1 exchange and OAuth1-to-OAuth2 refresh | [Client exchanges](https://github.com/Asherlc/dofek/blob/585bfa7d2e9417bc77e9cef751a2ef5901fdbd7d/packages/garmin-connect/src/client.ts#L246), [provider token resolution](https://github.com/Asherlc/dofek/blob/585bfa7d2e9417bc77e9cef751a2ef5901fdbd7d/src/providers/garmin/provider.ts#L134) | Official authorization and refresh lifecycle replaces private tokens. |
| Complete private-token object serialized into `accessToken` with `garmin-connect-internal` marker | [Token adapter](https://github.com/Asherlc/dofek/blob/585bfa7d2e9417bc77e9cef751a2ef5901fdbd7d/src/providers/garmin/internal-tokens.ts), [auth persistence](https://github.com/Asherlc/dofek/blob/585bfa7d2e9417bc77e9cef751a2ef5901fdbd7d/packages/server/src/routers/garmin-auth.ts#L23) | Users reauthorize the approved app; private credentials are not converted into official grants. |
| Social-profile lookup and display name embedded in wellness URL paths | [Profile lookup and API methods](https://github.com/Asherlc/dofek/blob/585bfa7d2e9417bc77e9cef751a2ef5901fdbd7d/packages/garmin-connect/src/client.ts#L325) | Official account identity and documented resources replace private URLs. |
| Special bypass around rate limiting for the S3 consumer request | [Provider fetch wrapper](https://github.com/Asherlc/dofek/blob/585bfa7d2e9417bc77e9cef751a2ef5901fdbd7d/src/providers/garmin/provider.ts#L51) | Remove with consumer download. |
| Repeated full activity pagination, per-day gap queries, cursors, and one-job-per-step continuations | [Orchestrator](https://github.com/Asherlc/dofek/blob/585bfa7d2e9417bc77e9cef751a2ef5901fdbd7d/src/providers/garmin/sync-orchestrator.ts), [step planner](https://github.com/Asherlc/dofek/blob/585bfa7d2e9417bc77e9cef751a2ef5901fdbd7d/src/providers/garmin/sync-step-plan.ts), [cursor](https://github.com/Asherlc/dofek/blob/585bfa7d2e9417bc77e9cef751a2ef5901fdbd7d/src/providers/garmin/provider.ts#L17) | Durable official push processing replaces routine private polling; historical recovery remains constrained by access tier. |
| Chart-shaped activity samples | [2,000-point chart defaults](https://github.com/Asherlc/dofek/blob/585bfa7d2e9417bc77e9cef751a2ef5901fdbd7d/packages/garmin-connect/src/client.ts#L443), [detail writer](https://github.com/Asherlc/dofek/blob/585bfa7d2e9417bc77e9cef751a2ef5901fdbd7d/src/providers/garmin/sync-orchestrator.ts#L276) | Validate original FIT ingestion. The existing private FIT downloader is not used by live sync. |
| Separate REM timeline overlaid on light-sleep segments | [Sleep-stage parser](https://github.com/Asherlc/dofek/blob/585bfa7d2e9417bc77e9cef751a2ef5901fdbd7d/packages/garmin-connect/src/parsing.ts#L224) | Documented official stage payload replaces the private-response correction. |

Rate limiting currently adds substantial Garmin-specific behavior: an IP-wide
budget, five-second pacing, inferred initial budget of 20 requests, and fallback
cooldowns of two hours escalating to four. A 429 also removes remaining HR and
HRV steps from the checkpoint. Replace these assumptions with official delivery
and quota rules; retain the shared limiter for providers that need it. Evidence:
[provider fetch scope](https://github.com/Asherlc/dofek/blob/585bfa7d2e9417bc77e9cef751a2ef5901fdbd7d/src/providers/garmin/provider.ts#L169),
[queue settings](https://github.com/Asherlc/dofek/blob/585bfa7d2e9417bc77e9cef751a2ef5901fdbd7d/src/jobs/provider-queue-config.ts#L69),
[adaptive defaults](https://github.com/Asherlc/dofek/blob/585bfa7d2e9417bc77e9cef751a2ef5901fdbd7d/packages/provider-http/src/adaptive-rate-limit.ts#L19),
[cooldowns](https://github.com/Asherlc/dofek/blob/585bfa7d2e9417bc77e9cef751a2ef5901fdbd7d/src/jobs/provider-rate-limit-cooldown.ts#L39), and
[step dropping](https://github.com/Asherlc/dofek/blob/585bfa7d2e9417bc77e9cef751a2ef5901fdbd7d/src/providers/garmin/sync-checkpoint.ts#L66).

The private client source plus `src/providers/garmin/` total approximately
3,159 lines, excluding tests, dedicated auth UI/router, and export import.
This measures the review surface, not an expected deletion count: mapping and
persistence responsibilities still exist. See the
[client package](https://github.com/Asherlc/dofek/tree/585bfa7d2e9417bc77e9cef751a2ef5901fdbd7d/packages/garmin-connect/src/) and
[provider adapter](https://github.com/Asherlc/dofek/tree/585bfa7d2e9417bc77e9cef751a2ef5901fdbd7d/src/providers/garmin/).

### Components to preserve

- **FIT decoding and ingestion.** The [native decoder](https://github.com/Asherlc/dofek/blob/585bfa7d2e9417bc77e9cef751a2ef5901fdbd7d/native/fit-decoder/README.md)
  already uses Garmin's official [FIT C++ SDK](https://github.com/garmin/fit-cpp-sdk),
  with bounded batches and backpressure. Reuse its capabilities and the
  [FIT import processor](https://github.com/Asherlc/dofek/blob/585bfa7d2e9417bc77e9cef751a2ef5901fdbd7d/src/jobs/process-fit-file-import-job.ts), preserving
  correct API/file provenance and official activity identity.
- **Account-export imports and existing history.** The
  [dump importer](https://github.com/Asherlc/dofek/blob/585bfa7d2e9417bc77e9cef751a2ef5901fdbd7d/src/providers/garmin-dump.ts) imports summaries, activity
  FITs, and weight FITs. Its [durable job flow](https://github.com/Asherlc/dofek/blob/585bfa7d2e9417bc77e9cef751a2ef5901fdbd7d/src/jobs/garmin-dump-flow.ts)
  remains useful, especially because Starter excludes historical API access.
  Preserve both `garmin` and `garmin-dump` source records and their
  [shared family metadata](https://github.com/Asherlc/dofek/blob/585bfa7d2e9417bc77e9cef751a2ef5901fdbd7d/packages/providers-meta/src/provider-catalog.ts).
- **Shared platform infrastructure.** Reuse [OAuth](https://github.com/Asherlc/dofek/blob/585bfa7d2e9417bc77e9cef751a2ef5901fdbd7d/src/auth/oauth.ts),
  [encrypted token storage](https://github.com/Asherlc/dofek/blob/585bfa7d2e9417bc77e9cef751a2ef5901fdbd7d/src/db/tokens.ts),
  [webhook infrastructure](https://github.com/Asherlc/dofek/blob/585bfa7d2e9417bc77e9cef751a2ef5901fdbd7d/packages/server/src/routes/webhooks.ts), queues,
  activity upserts, sensor publishing, and query-time deduplication. Remove
  Garmin-specific policies without dismantling these shared boundaries.

The [unofficial package](https://github.com/Asherlc/dofek/blob/585bfa7d2e9417bc77e9cef751a2ef5901fdbd7d/packages/garmin-connect/package.json) is configured
for public npm publishing. Removing its Dofek runtime dependency and retiring
its published API are separate decisions; do not silently repurpose its API as
an approved-partner client.

### Remaining migration decisions

Validate official payload coverage, missing values, units, identity mapping,
updates/deletions, delivery authentication, quota behavior, historical access,
and reconnect flows using the authorized
[catalog](https://developerportal.garmin.com/developer-programs/programs-docs).
Keep confidential contracts out of public documentation and fixtures.

Include disconnect and account erasure. Current Garmin
[auth setup](https://github.com/Asherlc/dofek/blob/585bfa7d2e9417bc77e9cef751a2ef5901fdbd7d/src/providers/garmin/provider.ts#L109) has no remote revocation
operation; stored connections reach the generic
[missing-revocation-policy error](https://github.com/Asherlc/dofek/blob/585bfa7d2e9417bc77e9cef751a2ef5901fdbd7d/src/account-erasure/remote-revocation.ts#L227).
Implement the verified official lifecycle rather than preserving that gap.

Women's Health no longer waits for initial business approval, but still needs
the app entitlement, authorized payload mapping, consent, and raw-record design.
API availability does not itself authorize restoring removed cycle features.
Keep Dofek's [schema policies](https://github.com/Asherlc/dofek/blob/585bfa7d2e9417bc77e9cef751a2ef5901fdbd7d/docs/schema.md), including the exclusion of
provider-estimated calorie expenditure, when evaluating newly available data.
