# Garmin Developer Program and migration assessment

Research date: 2026-10-21. Dofek has received Developer Program approval; its
running integration still uses private Garmin Connect endpoints. This note
separates the public program offering from current Dofek behavior. Field-level
parity, app configuration, and delivery guarantees must be verified against the
authorized [documentation catalog](https://developerportal.garmin.com/developer-programs/programs-docs)
before implementation. This document contains no confidential partner schemas.
The existing [client README](../packages/garmin-connect/README.md) describes the
unofficial implementation.

## Program scope

Garmin now distinguishes Personal, Starter Business, and Enterprise Business
access. Their delivery and history allowances differ; approval alone does not
establish Enterprise entitlement. The
[public overview](https://developer.garmin.com/gc-developer-program/overview/)
and [Developer Portal overview](https://developerportal.garmin.com/developer-programs/connect-developer-api) are the current
sources for product availability and app limits.

| Access | Publicly advertised capabilities | Delivery, history, and capacity |
|--------|----------------------------------|---------------------------------|
| Personal | Own-account Activity JSON/FIT, Health, and Women's Health | Personal key/tokens; pull only. Not business authorization for multiple users. |
| Starter Business | Health, Activity JSON/FIT, Women's Health, Training, Courses | Push only; no historical data; up to 1,000 users according to the portal. |
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

## Program conditions

The [public agreement](https://developerportal.garmin.com/developer-programs/4/nda-acceptance?nda=WyIyMzAxIl0%3D)
shown as version 9 on the research date prohibits collecting Garmin credentials
under section 15.8. Sections 5.2(o), 15.10, and 15.11 also constrain third-party
data access and AI use, including derived data. Confirm written authorization
for Dofek's intended AI/MCP use; developer approval and user consent alone should
not be treated as that authorization. Section 10.1 permits API fees, so older
FAQ wording does not establish current pricing.

The [public attribution guidelines](https://developer.garmin.com/downloads/brand/Garmin-Developer-API-Brand-Guidelines.pdf)
cover dashboards, detail screens, exports, and combined or derived analytics.
Review both clients and downstream data interfaces when scoping the migration.

## Current live ingestion

The [orchestrator](../src/providers/garmin/sync-orchestrator.ts) imports the
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
[client methods](../packages/garmin-connect/src/client.ts),
[parsers](../packages/garmin-connect/src/parsing.ts), and
[actual writers](../src/providers/garmin/sync-orchestrator.ts).

## Workarounds to retire

Replace the live integration with one official path once its required coverage
is validated. These are candidates for removal, not changes already made.
The current [auth router](../packages/server/src/routers/garmin-auth.ts) uses
the password for sign-in and persists the returned token object; it does not
store the password. Official consent would also remove Dofek's handling of
Garmin login credentials in transit.

| Current mechanism | Evidence | Retirement condition |
|-------------------|----------|----------------------|
| Dofek collects Garmin email/password, emulates SSO cookies, parses HTML CSRF/title/ticket | [Web modal](../packages/web/src/components/DataSourcesAuthModals.tsx), [mobile modal](../packages/mobile/components/providers/auth-modals.tsx), [auth router](../packages/server/src/routers/garmin-auth.ts), [client sign-in](../packages/garmin-connect/src/client.ts#L82) | Official OAuth connection works on web and mobile. The current client explicitly rejects interactive MFA. |
| Public third-party S3 consumer credentials and Android/iOS app user agents | [Client constants and consumer loading](../packages/garmin-connect/src/client.ts#L39) | Approved application credentials replace the emulated mobile identity. |
| Preauthorized OAuth1 exchange and OAuth1-to-OAuth2 refresh | [Client exchanges](../packages/garmin-connect/src/client.ts#L246), [provider token resolution](../src/providers/garmin/provider.ts#L134) | Official authorization and refresh lifecycle replaces private tokens. |
| Complete private-token object serialized into `accessToken` with `garmin-connect-internal` marker | [Token adapter](../src/providers/garmin/internal-tokens.ts), [auth persistence](../packages/server/src/routers/garmin-auth.ts#L23) | Users reauthorize the approved app; private credentials are not converted into official grants. |
| Social-profile lookup and display name embedded in wellness URL paths | [Profile lookup and API methods](../packages/garmin-connect/src/client.ts#L325) | Official account identity and documented resources replace private URLs. |
| Special bypass around rate limiting for the S3 consumer request | [Provider fetch wrapper](../src/providers/garmin/provider.ts#L51) | Remove with consumer download. |
| Repeated full activity pagination, per-day gap queries, cursors, and one-job-per-step continuations | [Orchestrator](../src/providers/garmin/sync-orchestrator.ts), [step planner](../src/providers/garmin/sync-step-plan.ts), [cursor](../src/providers/garmin/provider.ts#L17) | Durable official push processing replaces routine private polling; historical recovery remains constrained by access tier. |
| Chart-shaped activity samples | [2,000-point chart defaults](../packages/garmin-connect/src/client.ts#L443), [detail writer](../src/providers/garmin/sync-orchestrator.ts#L276) | Validate original FIT ingestion. The existing private FIT downloader is not used by live sync. |
| Separate REM timeline overlaid on light-sleep segments | [Sleep-stage parser](../packages/garmin-connect/src/parsing.ts#L224) | Documented official stage payload replaces the private-response correction. |

Rate limiting currently adds substantial Garmin-specific behavior: an IP-wide
budget, five-second pacing, inferred initial budget of 20 requests, and fallback
cooldowns of two hours escalating to four. A 429 also removes remaining HR and
HRV steps from the checkpoint. Replace these assumptions with official delivery
and quota rules; retain the shared limiter for providers that need it. Evidence:
[provider fetch scope](../src/providers/garmin/provider.ts#L169),
[queue settings](../src/jobs/provider-queue-config.ts#L69),
[adaptive defaults](../packages/provider-http/src/adaptive-rate-limit.ts#L19),
[cooldowns](../src/jobs/provider-rate-limit-cooldown.ts#L39), and
[step dropping](../src/providers/garmin/sync-checkpoint.ts#L66).

The private client source plus `src/providers/garmin/` total approximately
3,159 lines, excluding tests, dedicated auth UI/router, and export import.
This measures the review surface, not an expected deletion count: mapping and
persistence responsibilities still exist. See the
[client package](../packages/garmin-connect/src/) and
[provider adapter](../src/providers/garmin/).

## Components to preserve

- **FIT decoding and ingestion.** The [native decoder](../native/fit-decoder/README.md)
  already uses Garmin's official [FIT C++ SDK](https://github.com/garmin/fit-cpp-sdk),
  with bounded batches and backpressure. Reuse its capabilities and the
  [FIT import processor](../src/jobs/process-fit-file-import-job.ts), preserving
  correct API/file provenance and official activity identity.
- **Account-export imports and existing history.** The
  [dump importer](../src/providers/garmin-dump.ts) imports summaries, activity
  FITs, and weight FITs. Its [durable job flow](../src/jobs/garmin-dump-flow.ts)
  remains useful, especially because Starter excludes historical API access.
  Preserve both `garmin` and `garmin-dump` source records and their
  [shared family metadata](../packages/providers-meta/src/provider-catalog.ts).
- **Shared platform infrastructure.** Reuse [OAuth](../src/auth/oauth.ts),
  [encrypted token storage](../src/db/tokens.ts),
  [webhook infrastructure](../packages/server/src/routes/webhooks.ts), queues,
  activity upserts, sensor publishing, and query-time deduplication. Remove
  Garmin-specific policies without dismantling these shared boundaries.

The [unofficial package](../packages/garmin-connect/package.json) is configured
for public npm publishing. Removing its Dofek runtime dependency and retiring
its published API are separate decisions; do not silently repurpose its API as
an approved-partner client.

## Remaining migration decisions

Validate official payload coverage, missing values, units, identity mapping,
updates/deletions, delivery authentication, quota behavior, historical access,
and reconnect flows using the authorized
[catalog](https://developerportal.garmin.com/developer-programs/programs-docs).
Keep confidential contracts out of public documentation and fixtures.

Include disconnect and account erasure. Current Garmin
[auth setup](../src/providers/garmin/provider.ts#L109) has no remote revocation
operation; stored connections reach the generic
[missing-revocation-policy error](../src/account-erasure/remote-revocation.ts#L227).
Implement the verified official lifecycle rather than preserving that gap.

Women's Health no longer waits for initial business approval, but still needs
the app entitlement, authorized payload mapping, consent, and raw-record design.
API availability does not itself authorize restoring removed cycle features.
Keep Dofek's [schema policies](schema.md), including the exclusion of
provider-estimated calorie expenditure, when evaluating newly available data.
