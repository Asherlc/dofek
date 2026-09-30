# Mountain Project provider

The Mountain Project integration syncs a connected user's route and boulder
ticks as standalone climbing entries. It is an unofficial integration and
fetches a public export endpoint observed on
[Mountain Project](https://www.mountainproject.com/).
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

The provider fetches this complete, unpaginated CSV export on every sync. This
is an observed application endpoint, not a supported official API contract:

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

- `Date` is a date-only `YYYY-MM-DD` value. Each supported row is stored as one
  climbing entry; it does not create an activity or session.
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
produce a replacement ID; full-list reconciliation marks the stale tick
absent when it disappears from the export. Same-day duplicate laps receive
distinct occurrence indexes.

## Climbing style and result coverage

The observed export separates the climbing method (`Style`) from the result
qualifier (`Lead Style`). The
[current importer](../src/providers/mountain-project.ts) retains both columns
in the raw row and already interprets these values:

| Source values | Current normalized result |
| --- | --- |
| Boulder `Style = Send` or `Flash` | Sent |
| Boulder `Style = Attempt` | Not sent |
| Route `Lead Style = Onsight`, `Flash`, `Redpoint`, or `Pinkpoint` | Sent |
| Route `Lead Style = Fell/Hung` | Not sent |
| Route with blank `Lead Style`, including `Style = TR` | Result unknown |

Route `Style` values `Lead`, `TR`, `Follow`, and `Solo` populate canonical
`climb_style` independently of `result_style`. Route result labels come from
`Lead Style`; boulder result labels come from `Style`. Both clients render the
method and recorded label, including Fell/Hung as “Fell or hung” and Frenchfree
as recorded. The [permanent view](climbing-context.md#interpretation) derives
send status while preserving unknown results. Total attempt counts remain
null because the checked export has no count field.
`TR` specifies top-rope climbing; it does not establish a clean send. The
combined `Fell/Hung` value does not distinguish a fall from a hang or report
how many occurred. This coverage was checked against the observed tick-export
contract and importer on 2026-09-29. Source surface:
[Mountain Project](https://www.mountainproject.com/).

## Tick dates and activity matching

An unattached tick stores the exported date as its normalized
`unattached_date`. When a user attaches it to a climbing activity, that date is
cleared and the activity becomes the source of the tick's day. Activity detail
suggestions include active unattached entries from supported climbing providers,
including Mountain Project and OpenBeta, whose exported day equals the
activity's displayed calendar date in the user's timezone. A matching day only
suggests an entry; the user attaches each entry explicitly. Attached entries
keep their association across later syncs. Unattached entries contribute to
climb and grade summaries, but never create an activity, session, or duration.

See the [schema guide](schema.md#activities) for the stored association and
date rules, and the [unattached ticks design spec](superpowers/specs/2026-09-26-unattached-mountain-project-ticks-design.md)
for the full matching and sync contract.

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

## Location, angle, and board coverage

A read-only tick-export audit on 2026-09-29 confirmed the 15 columns listed
above. The importer splits `Location` at ` > ` into an ordered
`fitness.climbing_entry.location_path` of nonempty names and retains the
exported row in `raw`. IDs and roles stay null because the export supplies
neither. The read view derives the complete display label from those nodes.
For [Cragmont Crack](https://www.mountainproject.com/route/105734660/cragmont-crack),
the location path is:

```text
California > San Francisco Bay Area > East Bay Area > Berkeley > Cragmont Park > Northeast Face
```

This is a hierarchy of names, not location IDs or a fixed three-level model.
The same nesting appears on the public
[Northeast Face page](https://www.mountainproject.com/area/105734057/northeast-face).

Separate read-only requests to the undocumented
[route endpoint](https://www.mountainproject.com/api/v2/routes/105734660)
and [area endpoint](https://www.mountainproject.com/api/v2/areas/105734057)
returned a parent area ID/name, coordinates, and an area breadcrumb. The route
parent was `{ id: 105734057, name: "Northeast Face" }`; that area's parent was
`{ id: 105733893, name: "Cragmont Park" }`. These endpoints could supply
structured location references through additional requests, but the importer
currently uses only the CSV export. They remain observed application endpoints,
not a supported API contract.

Neither the checked export nor the sampled route responses supplied a dedicated
numeric wall-angle or board field. Route descriptions may describe a slab or
overhang, but that text does not establish an exact angle. Compare the explicit
Kaya fields in [kaya.md](kaya.md#observed-location-and-angle-values) and
OpenBeta's location hierarchy in [openbeta.md](openbeta.md#location-angle-and-board-coverage).

## Risks

- Private ticks may prevent reading an otherwise valid profile; this was not
  verified against a private account. Reconnect guidance names that setting.
- Large exports are fetched as one response. No undocumented pagination is
  assumed.
- The endpoint is unofficial and may change or become gated without notice.
  Sync errors are surfaced to the user and recorded in error monitoring.
