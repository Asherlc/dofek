<!-- cspell:words osmtags traversability -->
# Ghost Sessions

Working notes for Geoapify map-matching qualification (Task 1) and later
operator guidance. Design and implementation plan:

- [Ghost Sessions design](superpowers/specs/2026-11-24-ghost-sessions-design.md)
- [Ghost Sessions plan](superpowers/plans/2026-11-24-ghost-sessions.md)

Map-matching labels credit [OpenStreetMap](https://www.openstreetmap.org/copyright)
contributors. Trail geometry samples below also credit
[OpenFreeMap](https://openfreemap.org/) tiles and the
[OpenMapTiles](https://openmaptiles.org/) schema.

## Map-matching qualification (2026-11-24)

Public synthetic traces only. Requests sent `mode`, `waypoints[].location`, and
`lookup_step_osmtags=true`. No timestamps, account IDs, or sensor metrics.
Credential: existing Infisical `GEOAPIFY_API_KEY` documented in
[deploy/README.md](../deploy/README.md) (not recorded here).

Published references:

- [Map Matching API](https://apidocs.geoapify.com/docs/map-matching/)
- [Choose map matching mode](https://apidocs.geoapify.com/how-to/routing/choose-map-matching-mode)
- [Terms and Conditions](https://www.geoapify.com/terms-and-conditions/) (2 February 2024, Version 5)
- [Data Processing Agreement](https://www.geoapify.com/data-processing-agreement/) (revision 2024/08/15)
- [Pricing](https://www.geoapify.com/pricing/)
- OpenFreeMap planet tiles: `https://tiles.openfreemap.org/planet`

Public probes used `POST https://api.geoapify.com/v1/mapmatching` (global host
listed with Cloudflare in DPA Appendix 3). That is distinct from
`https://api-eu.geoapify.com`, which Appendix 3 associates with EU CDN routing.
Documented waypoint cap is 1,000; **these probes did not exercise that cap**.
Documented base credit formula is `max(1, ceil(waypoints.length / 100))`;
optional `geocode_step_address` adds one credit per geocoded step and was not
used. Each probe body therefore has a documented cost of 1 credit. Probe HTTP
responses returned **no** credit, quota, rate-limit, or remaining-use headers.

### Coverage metrics (keep separate)

| Metric | Meaning |
| --- | --- |
| Named step coverage | Observed count (or distance) of response `legs[].steps[]` with a non-blank `name` |
| Matched waypoint coverage | Observed count of input waypoints with `match_type=matched` |

These are not interchangeable. An approximate trail can return a named step
while most waypoints stay unmatched.

`from_index` and `to_index` on each step are indices into that step’s
**corresponding leg** `MultiLineString` coordinate array
(`features[0].geometry.coordinates[leg_index]`), not flat indices across all
legs and not raw GPS sample IDs. Slice
`coordinates[leg_index].slice(from_index, to_index + 1)` for the step geometry.
[Map Matching API](https://apidocs.geoapify.com/docs/map-matching/)

### Observed public traces

| Trace | Mode | Input waypoints | Observed named steps | Distinct step names | Observed matched waypoints | Notes |
| --- | --- | ---: | ---: | --- | ---: | --- |
| Embarcadero stretch | bicycle | 12 | 73 of 88 steps | The Embarcadero and connecting streets | 12 of 12 waypoints | Named road confirmed; 15 observed blank-name steps |
| Market Street stretch | walk | 8 | 13 of 48 steps | Market Street and connecting streets | 8 of 8 waypoints | Named road confirmed; 35 observed blank-name steps |
| Lands End approximate | hike | 10 | 2 of 6 steps | Mile Rock Trail | 2 of 10 waypoints | Named trail step present; 8 observed unmatched waypoints |
| Transverse Drive Trail (precise) | walk | 7 | 2 of 2 steps | Transverse Drive Trail | 7 of 7 waypoints | OpenFreeMap / OpenMapTiles / OSM-derived geometry |

### Public waypoint arrays and replay

Coordinates are `[longitude, latitude]`. Embarcadero and Market Street are
approximate public road lines. Lands End is an approximate public hike line.
Transverse Drive Trail points are the named geometry from current OpenFreeMap /
OpenMapTiles `transportation_name` tile `z14/x2617/y6333`, sampled every third
recorded map vertex in Golden Gate Park (© OpenFreeMap; © OpenMapTiles;
© OpenStreetMap contributors).

```json
{
  "named-road-bicycle-embarcadero": {
    "mode": "bicycle",
    "waypoints": [
      [-122.3937, 37.7955],
      [-122.3932, 37.7942],
      [-122.3926, 37.7929],
      [-122.3920, 37.7916],
      [-122.3914, 37.7903],
      [-122.3908, 37.7890],
      [-122.3902, 37.7877],
      [-122.3896, 37.7864],
      [-122.3890, 37.7851],
      [-122.3885, 37.7838],
      [-122.3880, 37.7825],
      [-122.3875, 37.7812]
    ]
  },
  "named-road-walk-market-st": {
    "mode": "walk",
    "waypoints": [
      [-122.4194, 37.7751],
      [-122.4178, 37.7756],
      [-122.4162, 37.7761],
      [-122.4146, 37.7766],
      [-122.4130, 37.7771],
      [-122.4114, 37.7776],
      [-122.4098, 37.7781],
      [-122.4082, 37.7786]
    ]
  },
  "named-trail-hike-lands-end": {
    "mode": "hike",
    "waypoints": [
      [-122.5055, 37.7879],
      [-122.5065, 37.7875],
      [-122.5075, 37.7872],
      [-122.5085, 37.7869],
      [-122.5095, 37.7866],
      [-122.5105, 37.7864],
      [-122.5115, 37.7862],
      [-122.5125, 37.7860],
      [-122.5135, 37.7859],
      [-122.5145, 37.7858]
    ]
  },
  "named-trail-walk-transverse-drive": {
    "mode": "walk",
    "source": {
      "tiles": "https://tiles.openfreemap.org/planet",
      "layer": "transportation_name",
      "tile": "z14/x2617/y6333",
      "name": "Transverse Drive Trail",
      "sampling": "every_third_vertex"
    },
    "waypoints": [
      [-122.478037, 37.766101],
      [-122.478488, 37.766249],
      [-122.47896, 37.766818],
      [-122.479518, 37.767751],
      [-122.479234, 37.768179],
      [-122.47896, 37.769252],
      [-122.479679, 37.770448]
    ]
  }
}
```

Turn any of the four entries into a POST body by wrapping each coordinate as
`{ "location": [lon, lat] }` under `waypoints` (do not log the key or URLs that
contain it). Example using the first and last Transverse Drive Trail points:

```json
{
  "mode": "walk",
  "waypoints": [
    { "location": [-122.478037, 37.766101] },
    { "location": [-122.479679, 37.770448] }
  ],
  "lookup_step_osmtags": true
}
```

`POST` that JSON to `https://api.geoapify.com/v1/mapmatching?apiKey=<GEOAPIFY_API_KEY>`
with `Content-Type: application/json`.

### Nested response fragments

Credentials are omitted. Geometry is not reproduced as a slicing fixture: the
raw public-only capture for Transverse chunk A did not retain the complete
16-point leg coordinate array that `to_index` 15 indexes into.

**Fragment 1 — field subset (named step and matched waypoints)** (Transverse
Drive Trail chunk A, `walk`, 2026-11-24 overlap probe; 1 observed named step of
1 step; 4 of 4 observed waypoints matched). This is a **properties field
subset**, not a fixture for `from_index` / `to_index` slicing. `geometry` is
omitted because only a truncated three-vertex sample was retained, which cannot
satisfy `to_index` 15. Waypoint coordinates below keep live API precision; the
middle two matched waypoints are omitted for brevity (`original_index` 0–3 were
all `matched`).

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": {
        "distance": 234,
        "time": 152,
        "mode": "walk",
        "legs": [
          {
            "distance": 234,
            "time": 152,
            "steps": [
              {
                "name": "Transverse Drive Trail",
                "road_class": "service_other",
                "surface": "dirt",
                "traversability": "both",
                "from_index": 0,
                "to_index": 15,
                "osm_way_id": 770906536,
                "distance": 234,
                "time": 152,
                "osmtags": {
                  "highway": "path",
                  "name": null,
                  "surface": "dirt"
                }
              }
            ]
          }
        ],
        "waypoints": [
          {
            "original_index": 0,
            "location": [-122.478038, 37.766101],
            "original_location": [-122.478037, 37.766101],
            "match_type": "matched",
            "match_distance": 0.087405,
            "leg_index": 0,
            "step_index": 0
          },
          {
            "original_index": 3,
            "location": [-122.479516, 37.76775],
            "original_location": [-122.479518, 37.767751],
            "match_type": "matched",
            "match_distance": 0.096742,
            "leg_index": 0,
            "step_index": 0
          }
        ]
      }
    }
  ]
}
```

**Fragment 2 — sanitized projection (Lands End)** (approximate `hike` probe;
observed counts unchanged: 2 of 6 steps named Mile Rock Trail; 2 of 10
waypoints matched; 8 unmatched). This JSON is a **sanitized projection** from
an earlier temporary sanitizer that mapped missing waypoint fields and blank
names to `null` and rounded some coordinates. Those inserted `null`s do **not**
prove original API field presence. Per the
[Map Matching API](https://apidocs.geoapify.com/docs/map-matching/), unmatched
points have no `match_distance`, `leg_index`, or `step_index` (they are absent,
not documented as JSON `null`). Geometry is omitted (fields truncated; no empty
`coordinates` array). Observed match counts still stand.

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": {
        "mode": "hike",
        "legs": [
          {
            "steps": [
              {
                "name": "Mile Rock Trail",
                "road_class": "service_other",
                "surface": "compacted",
                "traversability": "both",
                "from_index": 0,
                "to_index": 6,
                "osm_way_id": 701723960,
                "distance": 19,
                "time": 27,
                "osmtags": {
                  "highway": "path",
                  "name": null,
                  "bicycle": "no",
                  "surface": null
                }
              },
              {
                "name": null,
                "road_class": "service_other",
                "surface": "compacted",
                "traversability": "both",
                "from_index": 6,
                "to_index": 12,
                "osm_way_id": 33388450,
                "distance": 13,
                "time": 8,
                "osmtags": {
                  "highway": "path",
                  "name": null,
                  "bicycle": "no",
                  "surface": null
                }
              }
            ]
          }
        ],
        "waypoints": [
          {
            "original_index": 0,
            "location": [-122.50561, 37.7879],
            "original_location": [-122.5055, 37.7879],
            "match_type": "matched",
            "match_distance": 9.961,
            "leg_index": 0,
            "step_index": 0
          },
          {
            "original_index": 2,
            "location": [-122.5075, 37.7872],
            "original_location": [-122.5075, 37.7872],
            "match_type": "unmatched"
          }
        ]
      }
    }
  ]
}
```

Embarcadero also produced blank-name footway steps while nearby steps named
The Embarcadero (73 of 88 observed steps named; 12 of 12 observed waypoints
matched).

### Gaps, discontinuities, and chunk overlap

**Lands End gaps (tested):** With the approximate 10-point hike array above, the
API returned 2 matched and 8 unmatched waypoints (observed counts). Official
docs: unmatched points have no `match_distance`, `leg_index`, or `step_index`.
A short named Mile Rock Trail segment still appeared from the matched points.
This is approximate-trace mismatch, not a general discontinuity suite. Behavior
for true GPS gaps, multi-leg breaks, or empty features is **unknown** (not
tested).

**Workable chunk overlap (tested, two additional public requests):** The
seven-point Transverse Drive Trail array was split at the middle vertex
`[-122.479518, 37.767751]` (index 3), with that point repeated as the last
waypoint of chunk A and the first of chunk B.

| Chunk | Endpoint | Input waypoints | Observed matched waypoints | Distinct step name | Boundary matched location |
| --- | --- | ---: | ---: | --- | --- |
| A (indices 0–3) | `POST https://api.geoapify.com/v1/mapmatching` | 4 | 4 of 4 | Transverse Drive Trail | `[-122.479516, 37.76775]` |
| B (indices 3–6) | same | 4 | 4 of 4 | Transverse Drive Trail | `[-122.479516, 37.76775]` |

Both boundary waypoints were `match_type=matched` with identical
`original_location` `[-122.479518, 37.767751]`, identical matched `location`
`[-122.479516, 37.76775]`, and identical `match_distance` `0.096742`. On this
trace, the repeated overlap point can be deduplicated by either matched
location or original location. This does **not** claim general discontinuity
coverage, other modes, or that the documented 1,000-waypoint cap was tested.

### Contract observations for the adapter

- Response is a GeoJSON `FeatureCollection` with one `MultiLineString` feature
  in the successful probes above.
- Steps expose `name` (nullable), `road_class`, `surface`, `traversability`,
  `from_index` / `to_index` (leg-geometry relative), `osm_way_id`, `distance`,
  `time`, and optional `osmtags` when requested.
- Waypoints expose `original_index`, `match_type`
  (`matched` \| `unmatched` \| `interpolated` \| `merged`), `match_distance`,
  `leg_index`, `step_index`, and matched vs original locations.
- Blank `name` is common on footways, crossings, and short service segments
  even when nearby road or trail names are present.
- `osm_way_id` is useful for debugging but not a durable identity; OSM IDs can
  change ([Map Matching API](https://apidocs.geoapify.com/docs/map-matching/)).

### Terms, attribution, and DPA (published)

From the published
[Terms and Conditions](https://www.geoapify.com/terms-and-conditions/):

- Always provide OpenStreetMap attribution when using the Services.
- Geoapify attribution is mandatory on the Free subscription plan.
- Commercial Free-plan use in production is published as allowed only with
  limitations; contact Geoapify for details. Do not treat Free production use as
  unrestricted.
- Plan usage limits are the subscriber’s responsibility; overage may suspend
  service or add charges ([Pricing](https://www.geoapify.com/pricing/)).

Standard package attribution for map-matching results includes
`© OpenStreetMap contributors`, plus `Powered by Geoapify` when the active plan
is Free (paid plans may omit Geoapify branding where white-label applies). Trail
qualification samples additionally credit OpenFreeMap and OpenMapTiles as cited
above. Preserve vendor attribution on any retained map labels.

From the published
[DPA](https://www.geoapify.com/data-processing-agreement/) (Appendix 1): API
requests may include GPS coordinates; detailed personally identifiable request
data is kept only as needed to process the request and for aggregated billing
or monitoring, normally no longer than 24 hours (up to 2 months in exceptional
cases such as fraud). Appendix 3 lists Cloudflare for `api.geoapify.com` and
BunnyCDN for `api-eu.geoapify.com`; EU-only processing expectations follow the
EU host and the DPA’s EU/EEA locus language, not the global host used in these
public probes.

### Release gate (production project)

Before sending personal athlete coordinates after opt-in, verify for Dofek’s
production Geoapify project:

1. Endpoint (`api.geoapify.com` vs `api-eu.geoapify.com`) against the intended
   storage and processing terms.
2. Active plan tier and remaining credit quota (dashboard; not inferred from
   HTTP 200 or missing quota headers).
3. Permitted use for GPS trace / map-matching workloads.
4. Storage and retention terms for request payloads and any retained labels.
5. Attribution obligations for the chosen plan (OSM always; Geoapify on Free).

Published Free production use remains limited per the Terms. Prefer the
dashboard balance plus the documented credit formula over probe success alone.

## Map label operations

`GHOST_MAP_LABELS_REGION` defaults to `disabled`. Keep it disabled until the
production project meets the release gate above. Set it to `eu` for
`api-eu.geoapify.com` or `global` for `api.geoapify.com` after confirming the
corresponding endpoint and project. The deploy renderer requires
`GEOAPIFY_API_KEY` when map labels are enabled and forwards it to the label
worker. The web service already uses that key for place search. The analytics
worker needs the region setting to schedule enrichment.

Each label job sends up to four requests of at most 100 waypoints, including
shared endpoints between requests. It samples recorded positions about
every 20 metres, retains sharp turns and splits the request at recorded GPS
gaps. Geoapify receives coordinates, travel mode and the switch that requests
OpenStreetMap tags. The saved names use the corresponding recorded GPS
boundaries and credit OpenStreetMap contributors and Geoapify.

The label cache expires after 24 hours. Each entry belongs to the current
account, recording version and consent revision. Before dispatch and
publication, the worker checks current consent, source provenance and
ownership. Turning labels off expires the account's entries and invalidates
queued work from that consent revision. Confirm the 24-hour retention limit
against the production project terms before enabling the worker.
