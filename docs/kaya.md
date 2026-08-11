# Kaya API (Unofficial)

Reverse-engineered API behind [KAYA, the climber's app](https://kayaclimb.com/). There is
no official public API and no published documentation; Kaya support directs integration
questions to <support@kayaclimb.com>. Endpoints may change without notice.

Everything below was derived from the production web client at
<https://kaya-app.kayaclimb.com> (Create React App bundle
`/static/js/main.b2aae2ae.chunk.js`, app `version: "1.3.48"`) and confirmed against the
live API where the data is public. Authenticated behavior is marked as **unverified**
where it was established from GraphQL validation errors rather than real responses — see
[Verification status](#verification-status).

## Hosts

The client ships a single production config object:

```js
{
  type: "production",
  uri: "https://kaya-beta.kayaclimb.com",
  graphqluri: "https://kaya-beta.kayaclimb.com/graphql",
  subscriptionEndpoint: "wss://kaya-beta.kayaclimb.com/subscriptions",
  apolloClientOpts: { credentials: "same-origin" },
  stripeKey: "pk_live_...",
  version: "1.3.48"
}
```

The `kaya-beta` hostname is **not** a staging environment. It is the production API: the
live web app points at it and it carries a `pk_live_` Stripe key. There is no
`api.kayaclimb.com`.

| Surface | Endpoint |
| --- | --- |
| GraphQL | `POST https://kaya-beta.kayaclimb.com/graphql` |
| Auth (REST) | `POST https://kaya-beta.kayaclimb.com/api/user/*` |
| Subscriptions | `wss://kaya-beta.kayaclimb.com/subscriptions` |

## Required headers

The origin sits behind Cloudflare. Requests without browser-like headers are served a
Cloudflare interstitial (HTML, not JSON) instead of reaching the API. `/graphql` needs
`Origin`; the `/api/user/*` routes additionally need `Referer`. Sending both everywhere
is the reliable option:

```
Content-Type: application/json
Origin: https://kaya-app.kayaclimb.com
Referer: https://kaya-app.kayaclimb.com/
User-Agent: <a normal browser UA>
```

A default `curl`/`node-fetch` User-Agent is blocked. No Cloudflare JS challenge or
CAPTCHA solving was required from a datacenter IP during this work, but bot-management
rules are per-request and can tighten at any time — treat an HTML response body as a
retryable block, not a parse error.

The `recaptchaKey` in the client config (`6Lcv...`) is loaded globally by `index.html`
but is not sent by the login call; login needs no CAPTCHA token.

## Authentication

Auth is plain REST (not GraphQL), email + password. There is no OAuth flow, no client ID
or secret, and no developer registration.

### Login

```
POST /api/user/login
{ "email": "<email>", "password": "<password>" }
```

Success (`HTTP 200`):

```json
{
  "message": "ok",
  "token": "<access token>",
  "refresh_token": "<refresh token>",
  "user": { "id": "12345", "slug": "...", "...": "..." }
}
```

Failure is **also `HTTP 200`** with an error body — status code alone is not a success
signal on this route. Callers must check `message === "ok"`:

```json
{ "error": "Account not found or password invalid." }
```

The same endpoint handles social login with `{ "token": "<provider token>" }` instead of
email/password. A response of `{"message": "register"}` means the account does not exist
yet and must be created in the mobile app first.

### Refresh

```
POST /api/user/refresh-token
{ "refresh_token": "<refresh token>" }
```

Success returns `{ "message": "ok", "token": "<new access token>" }` — a new access token
only. **No rotated refresh token is returned**, so the stored refresh token is reused
indefinitely. Failure returns `HTTP 401` with
`{ "error": "Account not found or refresh token invalid." }`.

The web client refreshes on a fixed 30-minute timer (`setTimeout(..., 18e5)`) and on
window focus, and treats a `401` here as "logged out". Access-token lifetime is not
published in the response; 30 minutes is the client's assumption, not a server-stated
`expires_in`.

Other observed routes: `POST /api/user/checkauth`, `POST /api/user/logout`,
`POST /api/user/login-apple-web`.

### Using the token

Both the REST and GraphQL clients send:

```
Authorization: Bearer <access token>
```

The web client keeps the access token in memory and the refresh token in `localStorage`
(`refresh_token`), alongside `id` and `slug`.

## GraphQL

Standard Apollo Server. Introspection is **disabled** in production:

```
GraphQL introspection is not allowed by Apollo Server ... INTROSPECTION_DISABLED
```

Validation errors still discriminate reliably between a field that exists and one that
does not, which is how the authenticated types below were mapped:

- `Cannot query field "x" on type "T"` → field does not exist.
- `Field "x" of type "T!" must have a selection of subfields` → field exists, is an object,
  and the error names its type.
- `Server Error` / `INTERNAL_SERVER_ERROR` on an unauthenticated call → field exists and is
  auth-gated.

### Two parallel API surfaces

This is the most important structural finding. Kaya exposes **two** sets of root fields
over the same data:

| | `web*` fields | Unprefixed fields |
| --- | --- | --- |
| Consumer | web app | mobile app |
| Example | `webAscentsForUser` | `ascentsForUser` |
| Type | `WebAscent` | `Ascent` |
| Auth | public (respects `is_private`) | required |
| Attempts / ascent type | **absent** | present |
| Session linkage | **absent** | `session_id` + `sessionsForUser` |

The `web*` surface is a deliberately reduced public projection. `WebAscent` has no
`attempts`, `ascent_type`, `session_id`, `climb_id`, or `user_id` field — all confirmed
absent by validation error. **Any integration that needs attempt counts, send type, or
real sessions must use the authenticated mobile surface.**

### Root fields

Extracted from the web bundle (58 documents total — full text in
`docs/kaya-operations.graphql`):

- Public: `allGrades`, `webUser(username)`, `webUserById(id)`, `webAscentsForUser`,
  `webAscentsForClimb`, `webAscentsForGym`, `webAscentsForLocation`, `webClimb`, `webGym`,
  `webLocation`, `webPost*`, `webSearchFor{User,Climb,Gym,Location}`, `slugFor*`,
  `recommendedClimbsForWeb`, `webFilterDistributionForAscents`,
  `webLocationAscentsDistribution`.
- Authenticated: `currentUser`, `ascentsForUser`, `ascent(id)`, `sessionsForUser`,
  `receiptsForUser`, `userPaymentMethodLast4`.

### `currentUser`

```graphql
query currentUser { currentUser { id email fname lname username photo_url usac_id } }
```

Resolves the authenticated user's numeric `id`, which every `*ForUser` query needs.

### `ascentsForUser` (authenticated)

```graphql
ascentsForUser(user_id: ID!, offset: Int!, count: Int!, ...): [Ascent]
```

`Ascent` fields confirmed to exist:

| Field | Type |
| --- | --- |
| `id`, `date`, `comment`, `rating`, `stiffness`, `attempts`, `session_id` | scalar |
| `ascent_type` | `AscentType!` — only `{ id, name }` |
| `grade` | `Grade!` |
| `climb` | `Climb!` |
| `user` | `User!` |
| `gym` | `Gym` |
| `photo` / `video` | `Photo` / `Video` |

`AscentType.name` is expected to carry the same vocabulary as the CSV export
(`Flash`, `Onsight`, `Redpoint`, `Repeat`) — **unverified**, see below.

### `sessionsForUser` (authenticated)

```graphql
sessionsForUser(user_id: ID!, offset: Int!, count: Int!, ...): [Session]
```

`Session` fields confirmed to exist: `id`, `start_time`, `end_time`, `notes` (scalars),
`gym: Gym`, `board: Location`, `destination: Location`, `ascents: [Ascent]!`,
`user: User!`.

Sessions are a **first-class server-side object with real start and end times**. This
matters: the existing CSV importer has to synthesize sessions by grouping rows on
`gym + calendar date` and derive `startedAt`/`endedAt` from the min/max ascent timestamp.
The API removes that guesswork entirely.

### `webAscentsForUser` (public)

```graphql
webAscentsForUser(
  user_id: ID!, climb_type_id: ID, min_grade_id: ID, max_grade_id: ID,
  filter_by: filterAscentLocation, sort_by: sortAscents,
  offset: Int!, count: Int!
): [WebAscent]
```

Verified live response:

```json
{
  "id": "788465",
  "date": "2021-04-14T13:36:47.000Z",
  "comment": null,
  "rating": null,
  "stiffness": 0,
  "grade": { "id": "3", "name": "v1", "climb_type_id": "1", "grade_type_id": "1", "ordering": 30 },
  "climb": {
    "slug": "LCC-VauxEast-v1-1320876",
    "name": null,
    "climb_type": { "name": "Bouldering" },
    "color": { "name": "White" },
    "gym": { "name": "LCC VauxEast" },
    "board": null, "destination": null, "area": null
  }
}
```

Notes:
- `date` is a full ISO-8601 UTC timestamp, not a date-only string as in the CSV export.
- Gym climbs carry `climb.gym`; outdoor climbs carry `destination`/`area`; board climbs
  carry `board`. These are mutually exclusive and all nullable.
- `climb.name` is frequently `null` for gym problems, which are identified by `slug`.
- Paging is `offset`/`count`; the web client uses `count: 12` with infinite scroll.

### Enums

`sortAscents` = `DATE`, `GRADE`, `RATING` (`DATE` and `GRADE` verified live; `RATING`
inferred from the client's sort menu). `filterAscentLocation` corresponds to the client's
Outdoor / Gym / Board / All options; exact spellings not verified.

Enum values are `SCREAMING_CASE`. Apollo's error messages leak valid values via
`Did you mean the enum value "DATE"?`.

## Grades

`allGrades` is public and returns the full 164-row grade table — the authoritative mapping
from `grade.id` to a human grade name.

```graphql
query allGrades { allGrades { id name climb_type_id grade_type_id ordering mapped_grade_ids climb_type_group } }
```

| `climb_type_id` | `grade_type_id` | Scale | Examples |
| --- | --- | --- | --- |
| 1 (Bouldering) | 1 | V scale | `vB`, `v0`, `v1` … |
| 1 (Bouldering) | 2 | Font | `4A`, `6A+`, `7C` … |
| 2 (Routes) | 1 | YDS | `5.7`, `5.10a` … |
| 2 (Routes) | 2 | French | `5a`, `6a`, `7b+` … |
| 2 (Routes) | 3 | UIAA | `5-`, `6`, `7+` … |
| 2 (Routes) | 4 | YDS variant | `5.7`, `5.10a` … |

`ordering` gives a stable numeric sort across scales, and `mapped_grade_ids` cross-links
equivalent grades between scales. Unknown/unset grades appear as `v?` / `5.?`.

## Verification status

Verified live against the production API (public data, unauthenticated):

- Cloudflare header requirements and the HTML-block failure mode.
- Login and refresh request/response shapes for the **failure** paths, including the
  `HTTP 200`-with-`error` login quirk.
- Introspection being disabled, and the validation-error oracle.
- `allGrades` (full 164-row table), `webSearchForUser`, `webAscentsForUser` with real
  response payloads.
- `sortAscents` accepting `DATE` and `GRADE`.
- Existence of `ascentsForUser`, `sessionsForUser`, `ascent`, `currentUser` and the field
  sets of `Ascent`, `AscentType`, and `Session`.

**Not verified** — no Kaya account was available during this work:

- Any authenticated response body. Field *existence* on `Ascent`/`Session` is proven, but
  value shapes are not: the format of `Session.start_time`/`end_time` (ISO string vs epoch),
  the exact `AscentType.name` vocabulary, whether `attempts` is `null` or `1` for a flash,
  and whether `ascentsForUser` supports the same filter arguments as `webAscentsForUser`.
- The successful login/refresh response beyond the field names read out of the client
  bundle.
- Rate limits. None were observed or documented; assume they exist and back off on `429`.

Capture real fixtures against a live account before relying on any of the unverified
items above.
