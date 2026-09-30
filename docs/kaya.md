# Kaya provider

The `kaya` provider connects a user’s Kaya account with their email and
password, then syncs climbing sessions, ascents, and attempted climbs from Kaya’s authenticated
application API. `kaya-export` remains a separate CSV-import provider.

The contract in [kaya-api.openapi.yaml](kaya-api.openapi.yaml) records responses
observed from the authenticated [Kaya web app](https://kaya-app.kayaclimb.com/).

For routes, Kaya’s explicit `climb.lead` boolean is stored as the canonical
nullable `fitness.climbing_entry.lead` value: `true` is lead and `false` is
top-rope. Boulder entries store `null`, because Kaya returns `false` for them
without a rope-style meaning.

## Attempts and unknown counts

The session request includes `attempted_climbs` alongside the separate
`ascentsForUser` request. An attempted climb is a climb record whose ID combines
the session and climb IDs, rather than an individual try. It imports as an unsent
`climbing_entry`; ascent records keep their own source IDs, even when both feeds
refer to the same climb. Both responses can supply `attempts: null`. Preserve
that unknown count, and do not infer individual tries or failure reasons.
This contract was verified against the authenticated [Kaya GraphQL endpoint](https://kaya-beta.kayaclimb.com/graphql)
on 2026-09-29 and the [Kaya application](https://kaya-app.kayaclimb.com/).

Climbing summaries include these records and retain known send counts. An
attempt total is `null` when any contributing count is unknown; both clients
display the missing count explicitly. The outcome and count are independently
nullable in PostgreSQL, whose [check constraints](https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-CHECK-CONSTRAINTS)
allow unknown values while retaining the positive-count constraint.

## Confirmed request coverage

The following additional fields were verified in the authenticated API and the
[Kaya application's GraphQL fragments](https://kaya-app.kayaclimb.com/static/js/main.5bd87165.chunk.js)
on 2026-09-29. They are not currently requested:

| Record | Fields |
| --- | --- |
| Climb | `slug`, `color { name }`, `angle`, `description` |
| Climb location | `board`, `destination`, `area`, `subarea` (IDs and names) |
| Ascent | Its own `grade`, `photo { photo_url thumb_url }`, `video { video_url thumb_url }` |

For the reported session, climb colors and slugs were populated; the other
listed metadata was null, and ascent grades matched the climb grades. Session
notes, session board/destination details, and ascent comments/ratings/stiffness
are already requested and preserved in raw payloads. The application fragments
also contain access/moderation metadata and provider-computed aggregates; these
are outside the current import. This is an observed field audit, not an
exhaustive schema inventory: Kaya disables GraphQL introspection on this endpoint.
Source: [Kaya application](https://kaya-app.kayaclimb.com/) and authenticated
[GraphQL endpoint](https://kaya-beta.kayaclimb.com/graphql), observed 2026-09-29.
