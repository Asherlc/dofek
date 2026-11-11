# Climbing logbook API access research

<!-- cspell:words vlatka boardlink sportclimbing gymroute gymboulder -->

Checked **2026-11-01**. This records upstream access evidence separately from
implemented Dofek connections. Current product behavior remains documented in
[climbing-providers.md](climbing-providers.md).

## November 1 direct-sync verification

Using the existing signed-in Firefox session, a fresh Crimpd refresh request
returned HTTP 200 with `success`, `user`, `token`, `expiresIn`, `refreshToken`
and `refreshExpiresIn`. The observed access lifetime was 31,536,000 seconds;
the connector must consume the returned value rather than assume that lifetime.
The user's native account identifier is `user._id`, a string. The
[deployed client](https://my.crimpd.com/main.3bcc34bf74e9df68.js) stores raw token
strings under `auth/jwt` and `auth/refresh`, with millisecond expiry metadata.

The renewed access token independently read `/workout_log` from Node with HTTP
200 and zero records, and `/analytics/export?format=zip` with HTTP 200,
`application/zip`, and 899 bytes. Only the bearer header was supplied: no browser
cookies or app interceptors were used. For this one-time operator check, the
token crossed the browser/tool boundary only encrypted under an ephemeral local
public key; the private key was removed afterward. No token values were printed
or committed. This confirms server usability of renewed access credentials;
independent password exchange and populated workout coverage remain separate
validation items. Sources: the [current client](https://my.crimpd.com/) and
[export reference](https://crimpd.com/docs/data-export/).

Vertical-Life's earlier transport blocker is narrower than originally observed.
With the repository's existing Impit client, both Chrome and Firefox transports
returned HTTP 200 for the home page and HTTP 401 JSON for the unauthenticated
export endpoint. Normal Node fetch still returned Cloudflare HTTP 403. Impit
documents its browser-compatible HTTP/TLS transport in its
[JavaScript reference](https://apify.github.io/impit/js/).

An independent `GET /login` returned an authorization-code redirect with PKCE,
client `8a-nu`, and the vendor's `https://www.8a.nu/callback`. It set an HttpOnly,
Secure, SameSite=Lax `nu8a_session` cookie with a 604,800-second maximum age.
A single password-grant probe with intentionally invalid credentials returned
HTTP 401 `unauthorized_client` / `Invalid client or Invalid client credentials`;
this does not establish a usable password grant. The existing Firefox session
returned HTTP 200 from `/api/dotnet/me`, but exposed no token in local storage or
JavaScript-readable cookies. These initial checks did not establish server
login and renewal; the mobile-client verification below supersedes that blocker. Sources:
[vendor login](https://www.8a.nu/login),
[OIDC discovery](https://vlatka.vertical-life.info/auth/realms/Vertical-Life/.well-known/openid-configuration),
[web client](https://www.8a.nu/_nuxt/BvPRvgJk.js).

### Vertical-Life mobile-client verification

The existing Firefox sign-in completed authorization code with PKCE for the
public `vertical-life-ios` client and `vl-climbing://oauth2redirect`, requesting
`openid profile email offline_access`. A private local HAR capture supplied the
callback code to a Node exchange; callback state matched the generated request.
Both the code exchange and subsequent refresh returned HTTP 200. Access lifetime
was 300 seconds; `refresh_expires_in` was zero. This records the returned value,
not a guarantee that authorization cannot be revoked. The observed protocol
matches this [independent client implementation](https://github.com/raine/climbsheet/blob/beaa4248d2dd23f8a6be65188856dd21630031d4/src/vertical_life/auth.rs)
and the vendor's [OIDC discovery](https://vlatka.vertical-life.info/auth/realms/Vertical-Life/.well-known/openid-configuration).

Independent Node requests to the authorization endpoint returned a login form
with username, password, remember-me and login fields. Posting deliberately
invalid credentials to the same-origin form action returned the login form;
successful password submission from Node remains untested. The owner flow used
the existing browser sign-in. No browser profile or cookie jar is needed by the
implemented data client after token exchange; see the [client tests](../src/providers/eight-a/client.test.ts).

The issuer's `/userinfo` returned `scim_id`. Authenticated
`GET https://vlcapi.vertical-life.info/profile/v1/web/users/find?uuid={scim_id}`
returned `userSlug`, `uuid`, `avatar`, `eightAId`, names, privacy and following
metadata; its UUID matched `scim_id`. The deployed
[web API client](https://www.8a.nu/_nuxt/BvPRvgJk.js) uses the equivalent profile
lookup through its proxy. This mapping avoids treating the OAuth subject as the
numeric legacy app user ID.

Direct Node bearer requests to
`https://vlcapi.vertical-life.info/ascent/v1/web/users/{userSlug}/ascents`
succeeded for all four categories, using zero-based pages and the completeness
filters below. All owner categories were empty. Public outdoor bouldering and
sportclimbing responses were populated; no populated indoor record was
available. Returned fields included native `ascentId`, `platform`, date, grade,
names, type, tries, project/repeat/duplicate flags and additional source facts.
These checks used ordinary Node fetch, without browser cookies or Impit. The
upstream host also appears in the [independent mobile client](https://github.com/raine/climbsheet/blob/beaa4248d2dd23f8a6be65188856dd21630031d4/src/vertical_life/api.rs).

The implemented [Dofek client](../src/providers/eight-a/client.ts) then renewed
the owner's credentials, persisted the replacement through its callback, and
completed all four empty categories successfully. Unit fixtures cover populated
outdoor records, malformed pages, repetition, cancellation and renewal order;
they do not substitute for populated owner or indoor verification. Indoor grade
systems remain unknown rather than inferred. The [provider](../src/providers/eight-a/provider.ts)
uses a strict CSV/native transition: unmatched or ambiguous legacy history blocks
the transition, and connected uploads must match native records exactly and
uniquely. This avoids guessing whether an edited CSV row is a separate occurrence.
See the [identity resolver](../src/providers/eight-a/identity.ts) and
[current connection guide](climbing-providers.md#8anu--vertical-life).

## Crimpd: authenticated access verified

Method: inspect the JavaScript served by [Crimpd's web app](https://my.crimpd.com/)
(`main.3bcc34bf74e9df68.js`), then make read-only requests in Firefox using an
existing account's browser session. Keep credentials and token values out of
console output, fixtures, and this document. The deployed
[client bundle](https://my.crimpd.com/main.3bcc34bf74e9df68.js) is the primary
source for these undocumented app contracts.

Base URL: `https://api.crimpd.com`.

| Request | Observed contract and validation |
| --- | --- |
| `POST /auth/jwt` | The client sends JSON `{ username, password }` and consumes `user`, `token`, `refreshToken`, and `expiresIn`. Browser sign-in succeeded; an independent scripted password exchange was not tested. |
| `POST /auth/refresh` | JSON `{ refreshToken }`. Verified HTTP 200, with `success`, `user`, `token`, `expiresIn`, `refreshToken`, and `refreshExpiresIn` response keys. Updating the browser's stored credentials allowed a subsequent logbook read with HTTP 200. |
| `GET /workout_log?startDate=…&endDate=…` | ISO date parameters. Verified HTTP 200 with `success` and `workout_logs`; the account had no workout history, confirmed by its owner. A request without date parameters also returned HTTP 200 and an empty list. |
| `GET /workout_log/{logId}` | Client consumes `workout_log`. Not authenticated-tested because no existing log was available. |
| `GET /analytics/export?format=zip` | Verified HTTP 200 and `application/zip`; the returned archive contained `workouts.csv`, `sets.csv`, and `observations.csv`. The workout file contained a header and no data rows, consistent with the empty JSON logbook. |
| `GET /v2/user/observations?limit=500&cursor=…` | Verified HTTP 200 with `observations` and `nextCursor`. Observed record keys: `_id`, `id`, `attribute`, `value`, `unit`, `observedAt`, `observedAtTimeZone`, `source`, `sourceLogId`, `version`, `createdAt`, `updatedAt`. |

The successful reads supplied only `Authorization: Bearer <access-token>` as a
custom header. Browser fetch used its default cross-origin credentials policy,
so these checks did not include cross-origin cookies or the app's version,
platform, and requester-ID headers. This is stronger evidence than an
unauthenticated endpoint returning HTTP 401, but an independent server-side
session exchange remains unverified. See the request construction in the
[deployed client](https://my.crimpd.com/main.3bcc34bf74e9df68.js).

The observed workout CSV header also included `TIME_ZONE` and `LOCAL_DATE` after
`LOG_ID`. This differs from the September export documentation, which says the
original time zone is absent. Empty workout data cannot establish the values
or semantics of those columns. Do not infer them from their names alone.
Sources: [observed web client](https://my.crimpd.com/),
[published export reference](https://crimpd.com/docs/data-export/).

Before implementing automatic sync, verify a populated workout and export,
including per-set identities, missing/deleted workout definitions, and date
boundaries. Reusing the documented export through the existing
[archive reader](../src/providers/crimpd/archive.ts) and
[parser](../src/providers/crimpd/parser.ts) is a candidate; this investigation
does not establish that the JSON read path is more complete. The official
[export reference](https://crimpd.com/docs/data-export/) documents export limits.

## Vertical-Life: browser-session access verified

Vertical-Life officially synchronizes its logbook with 8a.nu, making the web
logbook a candidate access path. That announcement alone does not prove full
indoor-gym, project, or repeat coverage. Source:
[shared logbook announcement](https://www.8a.nu/news/find-your-logbook-in-the-vertical-life-app).

A third-party scraper implements
`GET /unificationAPI/ascent/v1/web/users/{userSlug}/ascents` on `www.8a.nu`, with
category, pagination, and filters. Its example requests disable projects,
repeats, and duplicates; those defaults are unsuitable evidence of a complete
logbook. The source is historical: direct unauthenticated requests returned a
Cloudflare HTTP 403 page, and authenticated browser requests to that old route
returned HTTP 404 for both the owner's and a public climber's logbooks. Source:
[scraper implementation](https://github.com/SebastianAuerbach/adam_ondra_logbook_scraper/blob/main/scraper.py).

Method: after the owner completed sign-in and email verification, inspect
browser resource entries and the currently deployed Nuxt client
[`BvPRvgJk.js`](https://www.8a.nu/_nuxt/BvPRvgJk.js), then make read-only
same-origin requests. The current prefix is `/api/unification`, replacing the
historical `/unificationAPI` prefix. The client exposes:

| Request | Observed contract and validation |
| --- | --- |
| `GET /api/unification/ascent/v1/web/users/{userSlug}/ascents` | Verified HTTP 200 for the owner's `bouldering`, `sportclimbing`, `gymroute`, and `gymboulder` categories. Each returned `ascents`, `totalItems`, and `pageIndex`, with an empty list in this account. |
| Same request for a public climber | Verified a populated bouldering response and three successive one-record pages with distinct native ascent IDs. Observed fields include `ascentId`, `platform`, `date`, `difficulty`, route/location names and slugs, `type`, `repeat`, `project`, `rating`, `category`, `secondGo`, `duplicate`, comments, and climbing-trait flags. The sample's platform was `eight_a`. |
| `GET /api/unification/ascent/v1/web/ascents/export-csv` | Verified HTTP 200 and `text/csv`. With `credentials: "omit"`, the same request returned HTTP 401 JSON. |

The CSV header was
`route_boulder,name,location_name,sector_name,area_name,country_code,date,type,sub_type,rating,project,tries,repeats,difficulty,perceived_hardness,comment,height,recommended,sits`.
No populated owner export or populated indoor response was available for
comparison. Sources: the deployed
[API client](https://www.8a.nu/_nuxt/BvPRvgJk.js) and
[user-logbook components](https://www.8a.nu/_nuxt/9KXPQ0_O.js).

**Pagination:** `pageIndex` starts at zero. `totalItems` was `1` on each of
three distinct one-record pages, so it must not be treated as the whole
logbook's total. The current indoor and outdoor components both increment
`pageIndex` after each nonempty result and stop on an empty `ascents` array;
the normal UI page size is 50. Include `includeProjects=true`,
`showRepeats=true`, and `showDuplicates=true` when validating complete source
history rather than copying the UI's default filters. Source:
[current pagination/filter implementation](https://www.8a.nu/_nuxt/9KXPQ0_O.js).

The live browser login redirects to the `Vertical-Life` realm on
`vlatka.vertical-life.info`, using authorization code with PKCE and client ID
`8a-nu`. Its public discovery document responds with HTTP 200. Discovery does
not grant third-party client registration or prove that the existing app's
credentials can be reused. Source:
[OIDC discovery](https://vlatka.vertical-life.info/auth/realms/Vertical-Life/.well-known/openid-configuration).

Staff describe CSV export under Profile Info → Edit → Logbook Export and say a
public ascent API was not planned at the time of the response. Later users
report difficulty finding the export control; the authenticated export
endpoint above worked without locating that control. Source:
[vendor forum discussion](https://www.8a.nu/forum/site-improvements/thread/export-or-download-scorecard).

The browser-session read contract is verified, including the indoor category
names, but unattended server authentication and session renewal are not.
Independent requests from Node still received Cloudflare HTTP 403. A successful
browser request does not prove a reusable bearer-token integration. Populated
owner/indoor records and completeness against the app remain validation gaps.
Sources: [current web app](https://www.8a.nu/),
[API client](https://www.8a.nu/_nuxt/BvPRvgJk.js).

## MoonBoard: new app API and device/export alternatives

The vendor announced replacement of the old app/API in 2026. Old website
logbook requests returned Cloudflare challenges in this investigation; this
alone does not prove the origin routes' status. Sources:
[official migration notice](https://moonclimbing.com/News/post/moonboard-app-update-important-information),
[community investigation](https://github.com/milwil-2/boardlink/issues/1).

The boardlink investigation identifies
`https://rest-v1.moonclimbing.com/_bs_api/v1/`, Firebase user authentication,
and an Apple App Attest-backed App Check token in `transfer-purpose`. It
observed problem detail and per-problem logbook-remark requests, not a proven
complete logbook enumeration contract. Its author explicitly leaves App Check
enforcement unresolved because stale user-auth tokens could explain HTTP 401.
An unauthenticated detail request here also returned HTTP 401 and cannot
resolve that question. Source:
[boardlink issue](https://github.com/milwil-2/boardlink/issues/1).

An independent Android interoperability investigation reports enforced
Firebase App Check with Play Integrity, even with valid account credentials.
Its published spec does not include the underlying request/response evidence,
so this is corroborating maintainer evidence rather than a live test by Dofek.
Source:
[CruxCoach investigation](https://github.com/CruxCoach/CruxCoach/blob/93998438abded3637d92706e8fc76d04754669b9/docs/specs/0.2.0/FEAT-027-moonboard-support.md#2-data-source--spike-resolved-2026-05-20).

CruxCoach implements two additional access paths worth distinguishing from
direct server sync:

- An Android accessibility service reads the installed official app. This is a
  device-assisted transfer, not a reusable server credential. Source:
  [accessibility service](https://github.com/CruxCoach/CruxCoach/blob/93998438abded3637d92706e8fc76d04754669b9/androidApp/src/main/java/com/cruxcoach/android/moonboard/MoonBoardAccessibilityService.kt).
- Its CSV parser accepts an account export with metadata before the header
  `ProblemId,Grade,Tries,Attempts,Rating,Date`. Its UI offers an account-data
  request, rather than demonstrating a current self-service export button.
  Board angle is not supplied by that format. Sources:
  [parser](https://github.com/CruxCoach/CruxCoach/blob/93998438abded3637d92706e8fc76d04754669b9/androidApp/src/main/java/com/cruxcoach/android/moonboard/MoonBoardCsvParser.kt),
  [request and limitation text](https://github.com/CruxCoach/CruxCoach/blob/93998438abded3637d92706e8fc76d04754669b9/androidApp/src/main/res/values/strings.xml).

Neither path was exercised against an actual account here. They must not be
advertised as supported by Dofek's existing historical BoardLib CSV importer:
the CSV headers and identity fields differ. See the current
[MoonBoard parser](../src/providers/moonboard/parser.ts).

An owner-signed-in iPhone app was inspected through iPhone Mirroring. Hub →
Logbook loaded an empty logbook. Settings showed hold-marker, group-climbing,
LED, and theme controls; the profile showed an edit action. No export control
was observed on those inspected screens. The Hub's lower account section was
not fully inspected because mirrored scrolling did not reliably advance it;
this is not proof that the app has no export function. No HTTPS capture,
certificate installation, or authenticated API replay was performed. The
inspected app is distributed through the vendor-linked
[App Store listing](https://apps.apple.com/us/app/moon-board/id6446842142);
the listing alone does not establish available export controls.

The unresolved direct-API check requires fresh user authentication and a known
read request, then distinguishing an authentication failure from an explicit
App Check rejection. Token presence alone does not establish enforcement;
custom backends implement their own validation. Source:
[Firebase custom-backend verification](https://firebase.google.com/docs/app-check/custom-resource-backend).
