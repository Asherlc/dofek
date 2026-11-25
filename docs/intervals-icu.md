# Intervals.icu provider setup

The provider ID is `intervals.icu`.

## Required environment variables

- `INTERVALS_ICU_CLIENT_ID`
- `INTERVALS_ICU_CLIENT_SECRET`

Set both in Infisical in each environment that offers the provider. Dofek shows the connection option once both credentials are configured.

The optional `INTERVALS_ICU_WEBHOOK_SECRET` authenticates push deliveries. Store it in Infisical
for environments that receive Intervals.icu webhooks. Deploy routing sends it only to the web and
pre-migration web services. Without it, `POST /api/webhooks/intervals.icu` returns 503 naming the
key.

## Vendor approval

Apply for an OAuth client and include Dofek’s redirect URI, `/callback` on the Dofek web host. Require S256 PKCE on the client. Intervals.icu must approve the app before users can connect. [OAuth application guide](https://forum.intervals.icu/t/intervals-icu-oauth-support/2759)

## Scopes and tokens

Dofek requests `ACTIVITY:READ`, `WELLNESS:READ`, and `CALENDAR:READ` and rejects a connection that
does not grant all three. Intervals.icu’s consent UI offers Read and Update per category; selecting
Update returns the matching `*:WRITE` scope, which implies the same-category `*:READ` grant, so a
token that returns `ACTIVITY:WRITE,WELLNESS:WRITE,CALENDAR:WRITE` satisfies the required READ set.
[OAuth scopes](https://forum.intervals.icu/t/intervals-icu-oauth-support/2759). Tokens have no
documented expiry or refresh credential, so Dofek stores the access token with a one-year
placeholder expiry and `reconnectStrategy: "replace"`.

Intervals.icu applies the athlete’s latest grant scopes to all tokens for the app. If an athlete reduces the scopes, they must grant all three again before all data can sync. [Intervals.icu scope behavior](https://forum.intervals.icu/t/intervals-icu-oauth-support/2759/24)

## Revocation

`DELETE /api/v1/disconnect-app` with the bearer token. Only HTTP 200 (revoked) and 401 (invalid bearer token, per the official
[API docs](https://intervals.icu/api/v1/docs)) are terminal; anything else is retried. Token and revoke requests do not follow redirects.

## Retained athlete binding

The athlete ID is stored as a keyed digest on `fitness.provider_data_generation`
(`source_account_digest`, `source_account_generation`). It survives disconnect and rejects a
different athlete while data is retained or deletion is pending. Completing the matching deletion
generation clears it; a binding re-touched for a newer generation is preserved. Metadata-only
bindings keep "Delete provider data" available.

## Registration and sync discovery

The worker registers the provider in
[`src/jobs/provider-registration.ts`](../src/jobs/provider-registration.ts) and the web server in
[`packages/server/src/routers/sync-helpers.ts`](../packages/server/src/routers/sync-helpers.ts).
Both load the same implementation through the package export
`dofek/providers/intervals-icu/provider` declared in
[`package.json`](../package.json). The existing built-in catalog entry is reused; no new entry is
introduced.

Discovery is credential-gated: the provider is registered unconditionally but the existing
`provider.validate() === null` filter in
[`packages/server/src/routers/sync.ts`](../packages/server/src/routers/sync.ts) hides it from the
connect and sync lists until both app credentials are configured. Scheduled and manual sync use
the same registry and shared sync flow once the provider is visible.

## Queue placement and rate limits

[`src/jobs/provider-queue-config.ts`](../src/jobs/provider-queue-config.ts) places `intervals.icu`
on the frequent tier with concurrency 1 and no fixed BullMQ limiter. The provider's shared fetch
([`src/providers/intervals-icu/provider.ts`](../src/providers/intervals-icu/provider.ts)) honors the
published rate-limit signals instead of duplicating a synthetic quota.

Intervals.icu documents daily and rolling 15-minute limits returned in `X-RateLimit-*` headers, an
additional **10 calls per second per IP**, and HTTP **429** with a `Retry-After` header. For OAuth
client apps the **default** daily allowance is 100 per user per day up to 500 users (minimum 5,000,
maximum 50,000 requests); the 15-minute allowance is one eighth of that with a minimum of 2,500.
These are vendor defaults for the app, not a guarantee for every installation; current limits and
usage are shown on the OAuth client management page. [Official API access and rate-limit guide](https://forum.intervals.icu/t/api-access-to-intervals-icu/609/1)

## What the integration reads

Dofek only reads from Intervals.icu; it never writes activities, wellness records, or calendar
events back to the source. [Official API access guide](https://forum.intervals.icu/t/api-access-to-intervals-icu/609/1)

- **Activities:** date-bounded completed workouts with their sensor streams, stored with source IDs
  and attribution. [Activities API reference](https://intervals.icu/api/v1/docs/swagger-ui/index.html#/Activities/listActivities)
- **Wellness:** recorded weight, resting heart rate, HRV, steps, SpO2, and reported sleep duration.
  Values marked temporary by Intervals.icu are treated as settings defaults, not measurements.
  Sleep is a date-level **reported duration in seconds**; Dofek does not infer episodes or stages.
  [Wellness API reference](https://intervals.icu/api/v1/docs/swagger-ui/index.html#/Wellness/listWellnessRecords)
  · [Wellness field definitions](https://forum.intervals.icu/t/server-side-data-model-for-scripts/25781/1)
- **Calendar:** scheduled `WORKOUT` events from the athlete's local-date calendar, including
  source-local dates, titles, notes, sport, and authored target units. [Calendar API and local-date semantics](https://forum.intervals.icu/t/api-access-to-intervals-icu/609/4)
  · [Planned workout guide](https://forum.intervals.icu/t/downloading-planned-workouts-from-the-api/93737)
  · [Event schema (`hide_from_athlete`)](https://intervals.icu/api/v1/docs/swagger-ui/index.html#/Events/listEvents)
  The documented date-only encoding is `T00:00:00`; Dofek treats exact `00:00`/`00:00:00` as no
  authored time for presentation while keeping the source-local calendar day. A coach-set
  `hide_from_athlete: true` event is excluded before the snapshot is written, so it never appears
  in upcoming workouts or exports, and reconciliation removes a previously visible row once its
  event becomes hidden. [Hiding workouts from athletes](https://forum.intervals.icu/t/hide-planned-workouts-from-athletes/5591)

Completed activities synced from Strava into Intervals.icu are not exposed by the Intervals.icu API,
so Dofek can treat them only as upstream presence, not as readable activity data. The same caveat
applies to Garmin-sourced data where the API and vendor terms permit it at all.
[Official API access guide](https://forum.intervals.icu/t/api-access-to-intervals-icu/609/1)

## Processing scope

Planned workouts stay in the existing user-owned PostgreSQL model covered by the relational
`providers` dataset in
[`src/processing/dataset-contracts.ts`](../src/processing/dataset-contracts.ts); no new dataset,
processing family, or CDC mirror is introduced, and the activities refresh family is unchanged.

## CLI connection and deployment keys

The generic CLI auth path in [`src/index.ts`](../src/index.ts) supports this provider without a
provider-specific branch. When `oauthConfig.usePkce` is set and the provider has not supplied a
prebuilt authorization URL, the CLI generates a verifier with `generateCodeVerifier()`, passes the
S256 challenge from `generateCodeChallenge()` to the shared `buildAuthorizationUrl()`, and forwards
the original verifier to `exchangeCode()`. Provider-supplied URLs are preserved unchanged.
To authorize from the CLI, set `OAUTH_REDIRECT_URI` to the local callback
`http://localhost:9876/callback`. The CLI listens on that port while authorization completes.

For connection setups that declare `reconnectStrategy: "replace"` or an `assertCanConnect` check —
including Intervals.icu and Garmin — token persistence runs inside `withProviderOperationFence`
and a single transaction that checks the retained athlete before `ensureProvider` and `saveTokens`.
A changed athlete is rejected before any credential is stored, and a failed attempt leaves the prior
connection intact. Legacy setups without either declaration keep the direct `ensureProvider` /
`saveTokens` path.

`INTERVALS_ICU_CLIENT_ID` and `INTERVALS_ICU_CLIENT_SECRET` are optional deployment keys. They are
routed only to the web and worker service environments by
[`scripts/deploy-service-environment.ts`](../scripts/deploy-service-environment.ts). Missing keys
hide new connections and pause scheduled sync. Disconnect and account erasure still revoke saved
bearer tokens through the vendor endpoint. [OAuth revocation](https://forum.intervals.icu/t/intervals-icu-oauth-support/2759)

## Webhooks

Open the Intervals.icu [Apps settings](https://intervals.icu/settings/apps) and choose Manage App
for the approved client. Register the HTTPS endpoint `https://dofek.fit/api/webhooks/intervals.icu`
and confirm the webhook secret matches `INTERVALS_ICU_WEBHOOK_SECRET` in Infisical. The worker uses
each athlete’s existing OAuth grant.
[API integration cookbook](https://forum.intervals.icu/t/intervals-icu-api-integration-cookbook/80090)

Enable these event types in the app’s webhook settings.

- `ACTIVITY_UPLOADED`
- `ACTIVITY_ANALYZED`
- `ACTIVITY_DELETED`
- `CALENDAR_UPDATED`
- `WELLNESS_UPDATED`

A historical vendor admin screenshot documents activity deletion among webhook types
([activity deletion availability](https://forum.intervals.icu/uploads/default/original/3X/3/0/3057cd07337b696d97e3a1e561bbdbbf57e8ad84.png)).
`WELLNESS_UPDATED` is covered in the vendor’s
[OAuth and wellness notes](https://forum.intervals.icu/t/intervals-icu-oauth-support/2759?page=2).
The current [API integration cookbook](https://forum.intervals.icu/t/intervals-icu-api-integration-cookbook/80090)
is authoritative for modern `CALENDAR_UPDATED`. Legacy `CALENDAR_EVENT_UPDATED` and
`CALENDAR_EVENT_DELETED` are not used. Calendar edits do not always produce a delivery.

Dofek groups events by connected athlete and queues one normal one-day sync per athlete per
delivery. The latest event time in the batch anchors the request. The worker fetches current
activity, wellness, and upcoming calendar data through the API. Intervals.icu omits Strava-sourced
activity webhooks and retries unsuccessful deliveries with backoff. Scheduled sync catches recent
changes when delivery is absent. Use manual backfill for older dates.

## Calendar dates and rollout

Dofek stores the calendar day and time reported by Intervals.icu. Relative wellness and calendar
sync windows use the Dofek home timezone. Explicit backfills retain the selected date labels.
Live acceptance needs to verify the window edges when the Dofek and Intervals.icu timezones
differ. [Calendar date behavior](https://forum.intervals.icu/t/api-access-to-intervals-icu/609/4)

Before enabling the provider in production, record the result of each check.

- [ ] Confirm approval of Dofek’s OAuth client and its registered redirect URI.
  Intervals.icu acknowledged the application.
  [Integration rollout record](https://github.com/Asherlc/dofek/pull/3442) ·
  [Vendor approval and grants](https://forum.intervals.icu/t/intervals-icu-oauth-support/2759).
- [ ] Run live acceptance in an isolated non-production Dofek deployment using
  an approved OAuth redirect. Configure both keys only in that deployment for
  testing. Install both production keys after OAuth approval and the
  acceptance checks below pass.
- [ ] Connect with a consenting test athlete and verify the granted
  `CALENDAR:READ` scope. Compare populated calendar responses with source
  event IDs, authored fields and units, local dates and times, and events
  near the date window edges. Save representative fixtures with personal
  values removed. [Calendar API](https://intervals.icu/api/v1/docs).
- [ ] Verify an edit, reschedule, explicit removal, and empty authoritative
  window. Confirm how enabled calendars, coach-hidden events, incomplete
  reads, and errors affect whether a snapshot can reconcile absence.
  [Calendar date behavior](https://forum.intervals.icu/t/api-access-to-intervals-icu/609/4) ·
  [Hidden workouts](https://forum.intervals.icu/t/hide-planned-workouts-from-athletes/5591).
- [ ] Check the same planned and completed workouts on web and iOS. Verify
  reconnect and confirm retained workouts show as snapshots after disconnect.

The 2026-11-24 production key-name check found neither OAuth key. Live calendar
acceptance is pending.
