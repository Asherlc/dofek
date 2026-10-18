# AllTrails Provider Research

<!-- cspell:words alltrails apkanalyzer apksigner appsflyer JADX javascripts ndimensional recaptcha -->

Last checked: 2026-10-18 (America/Los_Angeles).

## Finding And Scope

AllTrails has an internal account API with password authentication, access and
refresh tokens, recording enumeration, and recorded-route detail. The API is a
concrete candidate for automatic sync; the earlier import-only recommendation
did not account for the native identity-service implementation. The contracts
below come from deployed first-party [web source maps][web-login] and an
authentic, historical [Android APK][native-apk].

This investigation used public source downloads and static analysis. No account
login, authenticated API validation, app execution, or challenge bypass was
performed. **Current server acceptance remains unverified.** Native findings
are from **19.0.2**, not the latest Android release. A valid app signature and
available source do not establish present operation.

## Evidence And Reproduction

| Artifact | Identity and method | Relevant original sources |
|----------|---------------------|---------------------------|
| [Current web login source map][web-login] | Public Next.js assets linked by the site on the research date; inspect `sources` and `sourcesContent`. | `packages/user-auth/src/components/EmailPasswordLogin/index.tsx` |
| [Current web API wrapper source map][web-core] | Same deployment, asset revision `7454ca94ed332d519ef5b7580cbdcdac98d1934d`. | `packages/core/src/utils/api.ts` |
| [Deployed shared web source map][web-recordings] | Application bundle linked by the site's `/terms` page on the research date; includes legacy components, so deployment alone does not establish every component is active. | `app/javascript/application/javascripts/react_components/search/fullscreen/search_app.js`; `node_modules/@alltrails/maps/dist/utils/legacyGeoJSONConversions.js` |
| [Android APK][native-apk] | `com.alltrails.alltrails`, version `19.0.2`, build `53629`; manifest inspected with `apkanalyzer`, signature verified with `apksigner`, targeted classes decompiled with JADX 1.5.5. | `ServiceIdentityOAuth.kt`, `EndpointIdentityOAuthTokenPassword.kt`, `EndpointIdentityOAuthTokenRefresh.kt`, auth use cases, HTTP interceptors, `MapWorker.kt`, `MapSyncTask.java`, `SyncStatusResponse.java` |

The APK SHA-256 is
`81451a8e70e2f0d8094214ad86318104fcf5c04009dcadd334860ca4b1ae7500`.
Its signer SHA-256 is
`48ce7d26b14313d87f0d18e66509d890f112b69424e141c009b14fb475edb8f8`,
matching AllTrails' [published Android association][assetlinks]. The download
listing's recent timestamp does not describe the binary's version. Verify both
hash and manifest when reproducing this audit; the mirror URL can change.

The [deployed shared web source map][web-recordings] SHA-256 is
`df97efc316c6d46988a0d9f20acdddb75cecf2ef6d609a5311cf8aca97e17797`.

To inspect web originals, parse the source map JSON and locate the path in
`sources`; its corresponding `sourcesContent` entry is the original source.
For native auth, raw obfuscated interface names in this APK are `g34`
(password), `h34` (refresh), `e34` (legacy exchange), and `f34` (authorization
code). These names identify the inspected artifact, not future builds. App
keys, client ID values, credentials, and user tokens are intentionally omitted.

## Native Identity Contract: Android 19.0.2

### Initial Login

`EndpointIdentityOAuthTokenPassword` declares the following JSON request.
`ApiHostManager` and the shared Retrofit provider resolve the root-relative
endpoint to the production host shown here. The path is outside
`/api/alltrails/`. [Source: native APK][native-apk].

```http
POST https://api-v5.alltrails.com/identity/oauth/token
Content-Type: application/json
Accept: application/json
```

```json
{
  "client_id": "<native application client ID>",
  "grant_type": "password",
  "username": "<email>",
  "password": "<password>"
}
```

The DTO also has nullable `appsflyer_id`, `latitude`, and `longitude`; the
default `AuthLoginWithIdentityServiceUseCase` call leaves them null. Neither
`client_secret` nor `recaptcha` is a field of this native password DTO. This
describes the historical client request, not an exemption from present server
challenges. [Source: native APK][native-apk].

The response model contains top-level `access_token`, `refresh_token`,
`expires_in`, `created_at`, `token_type`, and `user`. `UserAuth` requires the
top-level access token, refresh token, and expiry to construct identity auth.
`user.id` identifies the account. `user.legacy_auth_token` and older
`permissions`/CSRF fields coexist in the model; they must not be mistaken for
the identity access token. [Source: native APK][native-apk].

### Refresh, Expiry, And Headers

`EndpointIdentityOAuthTokenRefresh` posts to the same `/identity/oauth/token`
endpoint with the following JSON. [Source: native APK][native-apk].

```json
{
  "client_id": "<native application client ID>",
  "grant_type": "refresh_token",
  "refresh_token": "<stored refresh token>"
}
```

`AuthRefreshUseCase` requires returned `access_token`, `expires_in`, and
`refresh_token`, then persists all three through `CanWriteLoginTokens`.
`SecondsFromNow` computes expiry as receipt time plus `expires_in` **seconds**.
`OauthTokenHandlerImpl` saves the absolute epoch-second expiry and both tokens
through Android DataStore. This proves support for durable refresh-token
rotation; it does not prove the server rotates on every response. Authenticated
requests can trigger proactive refresh once the token enters its final 30 seconds.
[Source: native APK][native-apk].

The inspected interceptors send these core headers. Their presence in the
client does not establish the minimum set currently required by the server.
[Source: native APK][native-apk].

| Header | Source and meaning |
|--------|--------------------|
| `X-AT-KEY` | Shared application key from Android's `api_key` resource; added independently of user login. |
| `X-AT-CLIENT-ID` | The same environment-selected native OAuth application ID used in JSON `client_id`; added on authenticated requests. |
| `X-AT-AUTH-TOKEN` | The identity access-token value selected by `ApplyAuthTokenToRequestUseCase`; not a standard `Authorization: Bearer` header. |

The client ID is application identity, not a user ID or device UUID. No
`client_secret` field or HTTP Basic client authentication was found in the
password/refresh declarations and inspected HTTP builder. The app also sends
version, locale, timezone, User-Agent, and Android device descriptors; this
audit does not establish that a provider needs to reproduce those descriptors.
[Source: native APK][native-apk].

### Other Auth Flows And Transport Limits

- `POST /identity/auth/tokens/exchange?client_id=...` exchanges an existing
  authenticated legacy token for identity tokens. The once-per-user migration
  calls it for a monolith login. It has no password body and is not an initial
  login mechanism.
- An authorization-code/PKCE implementation also exists. It exchanges
  `code`, `code_verifier`, `client_id`, `grant_type: "authorization_code"`, and
  `redirect_uri: "com.alltrails.app://auth/success"`. However, the inspected
  browser authorization activity targets **`alpha.alltrails.com`**. This is
  evidence of historical native implementation, not a current third-party
  OAuth registration path.
- `AllTrailsHttpClientBuilder` includes a DataDome interceptor, and
  `RequestInterceptorModule` handles CAPTCHA success, cancellation, and 403
  callbacks. Identity tokens therefore do not prove that unattended HTTP access
  works without anti-bot interaction. [Source for these flows and middleware:
  native APK][native-apk].

The current web login independently corroborates `/identity/oauth/token` with
`client_id`, `username`, `password`, and `grant_type: "password"`, but also
passes `recaptcha` when `recaptcha_user_signup_login` is enabled. That feature
and `identity_service` were enabled in the unauthenticated homepage bootstrap
captured on the research date. The native DTO's missing CAPTCHA field must not
be generalized to today's web flow. [Sources: web login][web-login],
[homepage][homepage].

## Recording Inventory And Detail

The deployed shared web component supplies a recording-specific inventory,
rather than relying on a social feed. `getUserMaps` selects
`presentation_type=track`, and `fetchAllMaps` follows cursor pagination.
[Source: `search_app.js` in the shared web source map][web-recordings].

```http
GET /api/alltrails/users/{userId}/maps?detail=algolia&presentation_type=track&limit=100&allow_private=true
```

The component adds `allow_private=true` for the signed-in account's own maps
(or a management permission). It reads `maps`, checks `pageInfo.hasNextPage`,
and sends `after=pageInfo.nextCursor` on the next page. This is evidence for
complete enumeration logic, not a tested guarantee about an account's current
private-history coverage. [Source: shared web source map][web-recordings].

`getSelectedTrackDetails` fetches the selected recording as follows and reads
`maps[0]`. The same click path opens `/explore/recording/{slug}`. Preserve
`combine_segments=false` when validating the raw recording shape.
[Source: shared web source map][web-recordings].

```http
GET /api/alltrails/maps/{recordingId}?detail=deep&combine_segments=false
```

Native `ApiHostManager` uses
`https://api-v5.alltrails.com/api/alltrails/` as its API base, and
`IAllTrailsService` independently declares `GET users/{id}/maps` with
`presentation_type`, `detail`, `limit`, and `after` queries plus
`GET maps/{mapSlug}` with deep detail. `MapCollectionResponse` contains `maps`
and nullable `pageInfo`. Native deep maps use lowercase `id`; the web's
Algolia-shaped inventory uses uppercase `ID`. The Dofek provider requests deep
inventory, includes the self-account private flag on every page, and requires
explicit pagination completion. Server acceptance still needs live validation.
[Sources: shared web source map][web-recordings], [native APK][native-apk].

Native `AlltrailsMap` contains `activity: {uid, name}`, `metadata`, and `tracks`.
`Track.lineTimedSegments` contains segment `id`, `sequence_num`, and `polyline`.
`Metadata.created` and `Metadata.updated` are strings; `Metadata.timezone` can
be null. The metadata fields do not establish recording-start time.
[Source: native APK][native-apk].

### Historical Incremental Sync

Android 19.0.2 also exposes a separate incremental operation through
`IAllTrailsService.syncMaps`. [Source: native APK][native-apk].

```http
GET /api/alltrails/maps/sync?last_sync_time=<previous sync timestamp>
```

`SyncStatusResponse` declares `new_ids`, `updated_ids`, and `deleted_ids`.
`MapSyncTask` handles the listed deletions, combines new and updated IDs for
downloads in batches of 25, and advances its persisted sync timestamp from
the response's `meta.timestamp`. The inspected raw task class is `gq8` in
`classes7.dex`; the response model is
`com.alltrails.model.rpc.response.SyncStatusResponse` in `classes3.dex`.
These are historical client semantics, not current authenticated validation.
[Source: native APK][native-apk].

The native `MapWorker` also requests deep user-map inventory and processes
the returned map objects directly. This supports investigating reuse of
embedded tracks, but does not establish that current inventory responses
contain complete, uncombined native timestamped segments. The deployed web
flow separately fetches selected deep detail with `combine_segments=false`.
[Sources: native APK][native-apk], [shared web source map][web-recordings].

Current acceptance of `maps/sync`, change retention, completeness, timestamp
boundaries, and replay behavior have not been validated. Adopting it requires a
validated durable timestamp and explicit deletion contract. Neither the
inventory's observed query parameters nor its cursor loop establishes a
filter by recording date or time ordering that permits an early cutoff.
[Sources: native APK][native-apk], [shared web source map][web-recordings].

## Raw Route Decoding

`legacyGeoJSONConversions.js` selects `routes` or `tracks`, then `lineSegments`
or `lineTimedSegments`, sorting by sequence. Its signed-delta polyline decoder
uses 64-bit arithmetic and per-axis decimal precisions. The split fields are:
[source: shared web source map][web-recordings].

| Field | Axes | Decimal precisions |
|-------|------|--------------------|
| `pointsData` | Latitude, longitude | `[5, 5]` |
| `indexedElevationData` | Point index, elevation in meters | `[2, 5]` |
| `indexedTimeData` | Point index, time value | `[2, 2]` |

Elevation and time are joined to coordinates by the **decoded point index**,
not by zipping arrays. The UI fills absent entries with zero; ingestion should
preserve missing values instead. Keep source segment membership so pauses do
not become connecting samples. A JavaScript decoder using only 32-bit bitwise
operations is unsuitable for epoch-scale encoded time values. These
implementation implications follow from the inspected decoder and its sparse
index joins. [Source: shared web source map][web-recordings].

Android 19.0.2 independently establishes a timed six-axis representation:
`TrackPointLocationUtil.populateFromLocation` copies Android `Location.getTime()`
to the point, and `TrackPointLocationExt.toPointArray` divides it by 1,000.
`toEncodedPolyline` feeds the array to the N-dimensional encoder. The format
dimensions are latitude, longitude, elevation, timestamp, horizontal accuracy,
and a second copy of horizontal accuracy, with decimal precisions
`[5, 5, 5, 2, 5, 5]`. Thus the fourth axis is **Unix epoch seconds at 0.01-second
precision**. A zero input time remains zero; the source does not establish its
server-side meaning. [Sources: native APK][native-apk],
[Android `Location.getTime()`][android-time].

The native `Polyline` model accepts `ndimensionalData`, and the shared web
source contains the same six-axis precision vector. However, the split web
time decoder only subtracts times; it does not establish the epoch origin of
current `indexedTimeData`. Do not substitute creation dates, moving-time
summaries, or fabricated times for missing raw timestamps.
[Sources: shared web source map][web-recordings], [native APK][native-apk].

No current personal-recording payload was obtained. A publicly committed
[`ha-ling-deep.json` fixture][route-fixture] decodes to 1,089 coordinates and
elevations, but has `presentationType=map`, no activity, and no time stream.
It is useful for geometry checks and cannot validate recorded activity time.

## Integration Assessment

The [Dofek provider](../src/providers/alltrails.ts) implements the native
credential flow, persisted refresh-token handling, cursor history, and raw
six-axis recording ingestion. Both worker and server register it; the shared
web/mobile credential form connects each user's account. The implementation
uses `ALLTRAILS_API_KEY` and `ALLTRAILS_CLIENT_ID` as application configuration
from Infisical, separate from the user's encrypted tokens and account ID.
See the [provider guide](../src/providers/README.md#alltrails) and
[credential storage contract](credential-encryption.md).

The current [sync implementation](../src/providers/alltrails.ts) enumerates
every inventory page and fetches separate deep detail for each recording
before applying the requested window to decoded raw GPS timestamps. Each
poll therefore costs the inventory requests plus one detail request per
recording, including unchanged and out-of-window recordings. Full inventory
preserves the implemented authoritative absence contract, but repeated detail
reads are a known request-volume limitation. The historical incremental and
embedded-track paths above are optimization candidates that have not been
implemented or validated against a live account.

Account deletion requires disconnecting AllTrails first. Dofek has no verified
AllTrails remote-session revocation policy, so the
[deletion prerequisite](../src/account-erasure/remote-snapshot.ts) rejects the
request before activation instead of leaving account erasure unable to finish.

The [database integration suite](../src/providers/alltrails-sync.integration.test.ts)
uses synthetic source-shaped responses through MSW, a real Postgres database,
and a capturing metric publisher. Local tests cannot establish current
AllTrails server acceptance. Before claiming current operation, validate:

1. Native identity login and one refresh, including receipt-relative expiry
   and persistence of the returned refresh token.
2. The accepted history host/headers and private-account visibility, plus an
   actual next-cursor response.
3. One genuine recording detail, preferably with multiple segments, whose
   decoded raw times match the known recording start/end.
4. The service's current challenge behavior and actionable reconnect errors.

These live-service checks remain unperformed. No account login is part of the
local test suite.

An AllTrails-issued delegated authorization-code client would be preferable
to collecting account passwords: OAuth's current security BCP disallows the
resource-owner password grant. No current third-party registration contract
was identified here; the alpha-targeted native PKCE code does not supply one.
[Sources: RFC 9700 section 2.4][oauth-bcp], [native APK][native-apk].

Dofek's [provider auth interface](adding-a-provider.md) and
[encrypted credential storage](credential-encryption.md) provide the account
boundary. Ingestion uses raw recording facts and sensor points under the
[canonical data rules](schema.md); provider summaries and estimated calorie
expenditure are retained only within opaque upstream payloads. Split-format
recordings without source-proven absolute sample times cannot be assigned
fabricated times. The provider does not automate browser verification or
implement the alpha-targeted PKCE flow.

## Other Official Surfaces

AllTrails documents [manual activity/route file downloads][exports], including
GPX, FIT, TCX, and JSON formats. Its [AI assistant integration][assistants]
documents trail discovery, details, weather, and maps without account setup;
those documented capabilities do not provide personal recording sync. These
surfaces do not negate the internal identity API found above.

[homepage]: https://www.alltrails.com/
[assetlinks]: https://www.alltrails.com/.well-known/assetlinks.json
[native-apk]: https://dl1.clic2load.fr/a/f/com.alltrails.alltrails.apk
[web-login]: https://d27scpai1jcyi9.cloudfront.net/7454ca94ed332d519ef5b7580cbdcdac98d1934d/_next/static/chunks/5351.03190f80fa961e18.js.map
[web-core]: https://d27scpai1jcyi9.cloudfront.net/7454ca94ed332d519ef5b7580cbdcdac98d1934d/_next/static/chunks/1413-084258f18f73e7ad.js.map
[web-recordings]: https://cdn-assets-2.alltrails.com/assets/packs/js/application-f8e06178361a7e1a1e3c.js.map
[android-time]: https://developer.android.com/reference/android/location/Location#getTime()
[route-fixture]: https://github.com/jordig20/4lltr4ils-gpx-extension/blob/bea4b52eb4280ab46a360768d4a4020ff8e27d97/test-fixtures/ha-ling-deep.json
[oauth-bcp]: https://www.rfc-editor.org/rfc/rfc9700.html#section-2.4
[exports]: https://support.alltrails.com/hc/en-gb/articles/37230403315476-Downloading-files-from-AllTrails
[assistants]: https://support.alltrails.com/hc/en-us/articles/47343827423764-AllTrails-integrations-with-AI-assistants
