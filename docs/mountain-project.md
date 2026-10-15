# Mountain Project provider

The Mountain Project integration syncs a connected user's route and boulder
ticks as standalone climbing log entries. It is an unofficial integration and
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
  climbing log entry; it does not create an activity or session.
- `URL` is retained as raw source data and participates in the content-derived
  tick identity.
- `Notes` populate the log. `Rating` belongs to the Climb's published grades;
  `Your Rating` belongs to the log's separately reported grades. `Pitches`,
  `Length`, stars, and rating code also remain in the raw row.
  `Your Stars = -1` means unrated.
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

## Attempt facts

The observed export separates `Style` from `Lead Style`. Dofek retains the
original labels and normalizes their independently supported facts through the
[importer](../src/providers/mountain-project.ts) and
[attempt normalizer](../src/db/source-attempt-facts.ts):

| Source value | Recorded facts |
| --- | --- |
| Lead / TR / Follow | Lead / top-rope / follow rope method |
| Solo / Aid | Independent solo / aid fact |
| Send, Redpoint, Pinkpoint | Completed free attempt; Pinkpoint also records preplaced protection |
| Onsight / Flash | First attempt index; supported completion and execution facts; beta follows the shared history rule |
| Boulder Attempt | Failed attempt |
| Fell/Hung | `fellOrHung = true`; completion remains unknown |
| Blank qualifier | Outcome and execution facts remain unknown |

The export supplies no attempt total, so each tick records one whole-Climb
occurrence. `Pitches` describes the tick's pitch extent and creates neither
additional tries nor catalogue Pitch objects. A top-rope method alone proves
no completion or free send. Advertised sport/trad route types belong to the
Climb and do not prove which protection the person used. These are Dofek's
[normalization rules](climbing-context.md), based on the observed
[tick export](https://www.mountainproject.com/user/200232920/cole-schmidt/tick-export).

## Tick dates and activity matching

The source calendar date is `climbed_on` and survives explicit attachment to
a climbing or hiking Activity. Same-day suggestions use the Activity's
displayed calendar date; a matching day does not attach a log automatically.
Later syncs retain the association. Undated logs remain available in provider
records, and standalone logs create no session or duration. See the
[association contract](climbing-context.md) and
[associator](../packages/server/src/repositories/climbing-log-entry-associator.ts).

## Grade handling

The [grade parser](../packages/mountain-project-client/src/grades.ts) retains
ordered components, including compound rock, ice, mixed, aid and commitment
grades. Recognized syntax receives a GradeSystem; uncertain text retains a
null system. A missing grade does not remove a log. Published `Rating` and
reported `Your Rating` remain separate collections, and discipline follows
the supplied route types rather than a required rock grade.

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
Area chain of nonempty names and retains the exported row in `raw`. Area
external IDs stay null because the export supplies none; names are not used
to merge source objects. The verified route URL identifies the Climb. The
read view follows its current Area ancestry rather than storing a path copy.
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
