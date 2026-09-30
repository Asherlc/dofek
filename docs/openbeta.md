# OpenBeta provider

The OpenBeta integration imports a connected user's public climbing ticks into
the canonical `fitness.climbing_entry` table. It is read-only and does not
create synthetic activities.

## Connection and API

The connection form accepts either a public profile URL such as
`https://openbeta.io/u/{username}/ticks` or the username itself. Dofek sends
the username to OpenBeta's public GraphQL `userPage` query, stores the returned
stable profile UUID in the per-user provider token record, and uses that UUID
with the paginated `userTicks` query.

OpenBeta documents `https://api.openbeta.io` as the production GraphQL
endpoint ([official API repository](https://github.com/OpenBeta/openbeta-graphql)).
The public website presents profile tick history at routes such as
[`/u/{username}/ticks`](https://openbeta.io/u/thickles/ticks).

## Stored records

Each supported tick becomes one standalone `fitness.climbing_entry` row:

- `external_id` is `openbeta:{tick-id}`.
- `unattached_date` is the tick's date-only `dateClimbed` value.
- boulders use V-scale first, then Font; routes use YDS first, then French,
  UIAA, Ewbank, or Brazilian Crux when available.
- `sent` is true for send-style attempt types and false for `Attempt`; a missing
  attempt type retains null sent/attempt count.
- `route_name`, `location_name`, and `source_name` are copied from the
  provider response when present.
- `raw` retains the selected OpenBeta GraphQL response object for provenance.

The provider uses a provider-scoped unique index for idempotent upserts. A
complete non-empty pagination run soft-tombstones rows missing from the
current list and restores rows that reappear. Empty, failed, malformed, or
partially unsupported responses do not reconcile absence because they are not
proof that the upstream log was intentionally cleared.

## Activity association

OpenBeta ticks use the same explicit activity-association flow as Mountain
Project ticks. Activity detail pages suggest active, unattached climbing
entries whose `unattached_date` matches the activity's displayed calendar day
in the user's timezone. The user attaches each entry individually; attachment
clears `unattached_date` and preserves the selected activity association.

The integration currently does not access private ticks, use account session
cookies, write to OpenBeta, enrich routes outside the tick response, or create
activities for tick dates.

## Location, angle, and board coverage

The current tick query selects only `climb.parent.area_name` for location and
copies it into `fitness.climbing_entry.location_name`. Full hierarchy names,
area UUIDs, and coordinates are not requested, so they are also absent from
the retained selected response. OpenBeta's
[tick schema](https://github.com/OpenBeta/openbeta-graphql/blob/f1508b2479cc7658ac4341d59ec817836190d6d8/src/graphql/schema/Tick.gql)
permits a null `climb` when a tick has no catalogue match; those ticks cannot
provide climb-linked location metadata.

Targeted schema introspection and public `climb`/`area` queries against
[the production GraphQL endpoint](https://api.openbeta.io) on 2026-09-29
confirmed additional fields defined in the official
[climb schema](https://github.com/OpenBeta/openbeta-graphql/blob/f1508b2479cc7658ac4341d59ec817836190d6d8/src/graphql/schema/Climb.gql)
and [area schema](https://github.com/OpenBeta/openbeta-graphql/blob/f1508b2479cc7658ac4341d59ec817836190d6d8/src/graphql/schema/Area.gql):

| Available field | Meaning and observed value |
| --- | --- |
| `climb.pathTokens` | Full hierarchy of area names; the checked responses run from the broadest area to the nearest parent. |
| `climb.ancestors` | Area UUIDs corresponding to that hierarchy. |
| `climb.parent.uuid`, `area_name` | Nearest area ID/name; Cragmont Crack's parent is `7120fcf9-ae19-5adc-ab0d-d04f749c2e91`, `Northeast Face`. |
| `Area.metadata.isDestination`, `leaf` | Area classification flags; Northeast Face returned `false` and `true`, respectively. These do not define a universal three-level hierarchy. |
| `climb.metadata.lat`, `lng` | Climb coordinates; Cragmont Crack returned `37.89205`, `-122.26333`. |
| `climb.metadata.mp_id` | Mountain Project route reference when supplied; Cragmont Crack returned `"105734660"`. |

The public
[Cragmont Crack record](https://openbeta.io/climb/6cc9b5d5-02d5-555a-948b-e2fffc9bd82c/cragmont-crack)
returned:

```text
USA > California > San Francisco Bay Area > Berkeley > Cragmont Park > Northeast Face
```

For matched ticks, these fields can be selected within `userTicks.climb`,
rather than requiring a separate route request. The checked climb/area schemas
define no dedicated numeric wall-angle or board field. Compare
[Kaya's explicit metadata](kaya.md#observed-location-and-angle-values) and
[Mountain Project's exported location path](mountain-project.md#location-angle-and-board-coverage).
