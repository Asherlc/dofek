# Mountain Project provider

The Mountain Project integration syncs a connected user's route and boulder
ticks into climbing activities. It is an unofficial integration and fetches a
public export endpoint observed on [Mountain Project](https://www.mountainproject.com/).
Use it only for the profile data that the connecting user is authorized to
access.

## Connection and scope

The connect form accepts a public profile URL or numeric profile ID and stores
the numeric ID as the user's provider connection value. It does not collect a
password, API key, or session cookie. The current scope is ticks only: no todo
list, login flow, or per-route enrichment is used.

The documented legacy Data API is not used. Live probing in August 2026 found
that its key-based tick endpoint rejects unavailable keys; Mountain Project's
[Data API page](https://www.mountainproject.com/data) is the relevant upstream
reference for that legacy surface.

## Tick export contract

The provider fetches this complete, unpaginated CSV export on every sync:

```text
GET https://www.mountainproject.com/user/{userId}/{slug}/tick-export
```

The endpoint behavior and fields below were observed through live HTTP probing
of production in August 2026, using placeholder data in repository fixtures.
The numeric profile ID is significant; the slug was observed to be ignored.
Unknown profiles returned HTTP 404. The provider treats a 404 or malformed
export as an actionable connection error and asks the user to confirm their
profile ID and private-ticks setting.

Observed CSV columns are:

```text
Date,Route,Rating,Notes,URL,Pitches,Location,"Avg Stars","Your Stars",Style,"Lead Style","Route Type","Your Rating",Length,"Rating Code"
```

- `Date` is a date-only `YYYY-MM-DD` value. Activities group rows by full
  location breadcrumb and date.
- `URL` is retained as raw source data and participates in the content-derived
  tick identity.
- `Notes`, `Pitches`, `Length`, average/user stars, user rating, and rating
  code remain in the raw row. `Your Stars = -1` means unrated.
- Roped `Style` values include Lead, TR, Follow, and Solo; boulder values
  include Send, Flash, and Attempt. `Lead Style` further identifies Lead
  ascents such as Onsight, Flash, Redpoint, Pinkpoint, and Fell/Hung.
- `Route Type` may be comma-separated (for example `Trad, Ice, Alpine`).
- `Rating Code` is an upstream sort key: observed YDS values are in the lower
  numeric namespace, V-scale values are around 20,000+, and unsupported
  ice/mixed ratings may be zero.

There is no tick ID. The provider derives an ID from date, route URL, style,
lead style, pitches, and occurrence order. Thus editing a source tick can
produce a replacement ID; full-list reconciliation tombstones the stale
activity session when it disappears from the export. Same-day duplicate laps
receive distinct occurrence indexes.

## Grade handling

The provider extracts and canonicalizes only leading YDS or V-scale tokens.
Examples: `5.7 PG13` becomes `5.7`, `5.10b/c` becomes `5.10b`, and
`5.5 WI2+ M2-3 Mod. Snow` becomes `5.5`. Pure ice, mixed, aid, snow, third-,
and fourth-class values are skipped and reported once as an aggregated sync
error because canonical climbing entries require a YDS or V-scale grade.

## Other observed endpoints

The following endpoints were observed but are intentionally not used by the
provider: `GET /user/{id}/{slug}/todo-export`, `GET /rss/user-ticks/{id}`,
`GET /api/v2/routes/{id}`, `GET /api/v2/areas/{id}`,
`GET /api/v2/routes/{id}/ticks`, and `GET /api/v2/search?q=`. They are
undocumented application surfaces, not supported public API contracts.

The site also exposes a Laravel session-login form at `GET /auth/login` with a
POST to `/auth/login/email`. It was deliberately not implemented because the
public tick export already supplied the required tick fields during probing.

## Risks

- Private ticks may prevent reading an otherwise valid profile; this was not
  verified against a private account. Reconnect guidance names that setting.
- Large exports are fetched as one response. No undocumented pagination is
  assumed.
- The endpoint is unofficial and may change or become gated without notice.
  Sync errors are surfaced to the user and recorded in error monitoring.
