# Kilter board and logged location

## Intent and scope

Resolve a Kilter log's recorded board and gym identifiers into a named physical
board and gym location. Display the result on web and iOS. The user approved
the goal of resolving log → board → gym/location; the storage and transport
details below are proposed for approval.

## Proposed design

- Keep the existing native log and climb identities. Enrich the log's existing
  board metadata with the board's name, retaining its wall identifier.
- Add an optional log-level Area reference for the gym, reusing the existing
  Area table and its name/coordinates. A Kilter problem remains one shared Climb
  even when logged at different gyms. The existing schema currently attaches
  Areas only to Climbs; see [the schema](../../../src/db/schema/climbing.ts).
- Serve the log's recorded Area path and map location ahead of the Climb's
  location when present. Preserve the current behavior for other providers.
- Show the resolved board and gym in the existing detail views on both clients,
  using the existing maps for known coordinates. Do not invent addresses,
  coordinates, gym associations, or names when the source omits them.
- Read the board/gym directory through the official PowerSync Node SDK with
  the connected account's existing renewable authorization. Use a disposable
  local mirror during sync and close/remove it afterward; do not introduce a
  persistent service, another canonical store, or a custom sync protocol.
- Verify authenticated directory access before relying on the contract. A
  failed lookup must fail the sync before authoritative reconciliation; a
  successful directory response lacking a referenced board/gym leaves its
  details unknown and preserves the native identifier.
- Normal sync updates existing log occurrences in place. Preserve raw source
  evidence and do not trigger an unsolicited production resync or deployment.

Kilter logs expose `wallUuid` and `gymUuid` in the
[BoardLib client contract](https://github.com/lemeryfertitta/BoardLib/blob/main/src/boardlib/api/kilter.py).
The [Hangtime implementation](https://github.com/Stevie-Ray/hangtime-climbing-boards/blob/main/api/kilter.client.ts)
joins `walls.gym_uuid` to `gyms.gym_uuid` and reads gym coordinates through
PowerSync. The [official SDK](https://github.com/powersync-ja/powersync-js/tree/main/packages/node)
provides the protocol implementation. Direct unauthenticated GET requests to
`https://portal.kiltergrips.com/api/walls` and `/api/gyms` returned HTTP 405
on November 9, 2026, so those guessed REST directory reads are not the design.

## Alternatives and trade-offs

The recommended SDK approach adds a dependency and a small schema migration,
but keeps the protocol maintained upstream and locations correct per log.
A third-party published location dataset avoids the SDK but introduces another
source of availability, freshness and identity assumptions. A custom PowerSync
stream reader adds maintained protocol code without a requirement the SDK
cannot meet. Attaching the gym to the shared Climb would misattribute logs made
at other gyms.

## Acceptance and checks

Test first: board/gym resolution; the same climb logged at two gyms; missing
identifiers and directory records; refreshed authorization; cancellation and
cleanup; failed/malformed directory responses preventing reconciliation.
Use real PostgreSQL tests for log-level Area persistence and location precedence.
Verify both clients render the named board and gym, preserve unknown locations,
and use the existing map path. Run the applicable lint, typecheck, migration,
unit/mobile and integration checks before committing and pushing.
