# BoardSesh app protocol research

Research date: **2026-11-12**. Dofek implements the password-based BoardSesh
provider using the inspected app protocol. Successful account authentication and
populated-history reads remain unverified because no authorized account was
available for acceptance testing.

## Method and evidence

Inspected the public mobile and backend source at commit
[`af2f7adf95eac77990b91da8d254d97ead25b938`](https://github.com/boardsesh/boardsesh/tree/af2f7adf95eac77990b91da8d254d97ead25b938),
downloaded the deployed Expo web JavaScript, and made small unauthenticated HTTP
requests. No account was created, no real credentials were submitted, and no
private logbook was accessed. Source inspection was sufficient; APK decompilation
was unnecessary because the [mobile implementation is public][mobile-auth].

Observed from this workstation:

| Request | Result |
| --- | --- |
| `GET https://app.boardsesh.com` | HTTP 200; Expo web app. |
| Deployed `__common-def1b60602b7e553ac604b44e51759c1.js` | HTTP 200; contains `https://ws.boardsesh.com`, `syncTicks`, and `syncDeletions`. |
| `POST https://ws.boardsesh.com/graphql`, targeted schema introspection | HTTP 200; confirms `syncTicks`, `syncDeletions`, `ticks`, `userAscentsFeed`, and `authenticatedUserId`. |
| `syncTicks(limit: 1)` without authentication | HTTP 200 with GraphQL error `Authentication required to perform this operation`; `data: null`. |
| `syncDeletions(limit: 1)` without authentication | Same authentication error. |
| `POST https://ws.boardsesh.com/auth/native/credentials` with `{}` | HTTP 400, `{"error":"email and password are required"}`. No account sign-in attempted. |
| OAuth discovery on `api.boardsesh.com` | DNS resolution failed on this workstation; no deployment status inferred from that failure. |

These observations establish deployed routes and authentication requirements,
not a successful authenticated integration. The app's default backend and HTTP
GraphQL path also appear in its [environment configuration][env] and
[GraphQL client][graphql-client].

## Native authentication

The app sends JSON `{ "email": "<email>", "password": "<password>" }` to
`POST https://ws.boardsesh.com/auth/native/credentials`. Its response contains
`jwt`, `refreshToken`, and `expiresAt`. The inspected backend issues a seven-day
JWT and a 90-day refresh token. Those lifetimes are source configuration, not
measured guarantees for the deployed service. See the [mobile sign-in][mobile-auth]
and [backend issuance/handlers][native-auth].

GraphQL accepts `Authorization: Bearer <jwt>` over ordinary HTTP POST; a
WebSocket connection is unnecessary for these queries. Native refresh uses
`POST /auth/native/refresh` with `{ "refreshToken": "<refresh token>" }`,
returns a replacement pair, and consumes the old refresh token. Any future
provider must serialize refreshes and persist the returned replacement before
further use. Authentication failures must be distinguished from transport and
GraphQL errors. See [HTTP bearer authentication][yoga],
[backend refresh][native-auth], and the [mobile refresh client][refresh-client].

Apple/Google sign-in also exists, with native identity-token verification and a
browser transfer-token exchange. The latter is tied to BoardSesh's native
callback flow; it is not evidence that Dofek can register its own callback.
An email/password provider alone would not cover accounts lacking a password.
See the [actual app sign-in flows][mobile-auth].

**Revocation has an account-wide side effect:** `POST /auth/native/revoke`
with a valid refresh token revokes all the account's mobile refresh tokens and
deactivates notification devices. It must not be treated as a connection-scoped
disconnect. This behavior is visible in the [backend handler][native-auth]; it
was not exercised against an account.

## Raw logbook reads

The authenticated `syncTicks` query reads the caller's ticks across board types:

```graphql
query Logbook($cursor: SyncCursorInput, $limit: Int! = 500) {
  authenticatedUserId
  syncTicks(cursor: $cursor, limit: $limit) {
    documents
    cursor { updatedAt syncSeq }
    hasMore
  }
}
```

Start with a null cursor. Feed the returned cursor back unchanged until
`hasMore` is false. Limits are 1–500. Keep `syncSeq` as a string, and preserve
timestamp precision. The server defaults to withholding rows younger than
30 seconds; new writes can therefore appear in a subsequent sync. See the
[resolver][sync], [schema][sync-schema], and [input validation][sync-validation].

Returned documents use these raw snake_case fields:

```text
uuid, user_id, board_type, climb_uuid, climb_revision, angle, is_mirror,
status, attempt_count, quality, difficulty, is_benchmark, comment,
climbed_at, session_id, created_at, updated_at
```

The tick UUID is the natural identity. This feed omits physical `board_id`,
layout, climb name, and upstream Aurora/Kilter bookkeeping. It cannot by itself
provide complete provenance or gym context. See the [selected columns][sync]
and [sync table contract][sync-manifest].

The richer `Tick` type exposes layout, physical board identity, upstream IDs,
and separate raw/effective grade and quality fields. Status values are `flash`,
`send`, and `attempt`. Its `attemptCount` describes attempts before success or
total attempts when unsuccessful; mapping that to Dofek's attempt occurrences
needs populated fixtures and inspection of upstream writes. Do not assume each
row is a single attempt or copy effective consensus values into personal grades.
See the [tick schema][ticks].

`ticks(input: { boardType, climbUuids })` is an authenticated per-board read
with optional climb filtering. `userTicks` is a visibility-filtered profile
read, so it is not a substitute for an authoritative private logbook.
`userAscentsFeed` offers paginated enriched display rows. These are potential
metadata-enrichment paths, rather than a reason to mirror the full catalogue;
their identity, filtering, and completeness still need account verification.
See the [tick read resolvers][tick-queries].

## Deletions and completeness

`syncDeletions` uses its own cursor and returns
`deletions { tableName recordId deletedAt }`, `cursor { updatedAt syncSeq }`,
and `hasMore`. Tick markers use table `boardsesh_ticks` and the tick UUID as
`recordId`. Ignore unrelated reference-table markers when importing logbooks.
See the [deletion resolver][sync] and [natural-key contract][sync-manifest].

Tombstones are retained for 90 days; the app's coverage guard uses an 80-day
threshold. An incremental reader cannot recover pruned deletions merely by
replaying an old cursor. A future provider needs a complete verified snapshot
reconciliation after lost coverage. Never treat a failed or partial read as
evidence that records were deleted. See [shared retention constants][retention].

The app sync cursor uses update timestamps and a sequence, with a stability
window rather than a transactional change feed. It is not an established
guarantee against every late-committing write. BoardSesh's integration design
explicitly identifies this limitation and chooses a transactional logbook feed
for its partner API. See [resolver mechanics][sync] and the
[integration design, decision D6][integration-platform].

## Integration decision and remaining verification

The app protocol is technically accessible without a developer client ID, but
it is an internal API with full account tokens. BoardSesh's hosted-service
policy distinguishes integrations from using its backend as another app's
service; the official app API draft describes scoped OAuth access but is not
generally open. These are separate questions from endpoint reachability. See
the [hosted-service policy][legal] and [partner API status][partner-api].

## Remaining live-account acceptance

1. Verify sign-in and refresh with an authorized account containing real history.
2. Compare a complete tick pull with the app/export; check flashes, sends,
   unsuccessful attempts, repeats, edited records, aliases, and imported logs.
3. Verify targeted metadata reads preserve raw IDs, personal grades, board/gym
   context, and accessible spray-wall records without catalogue mirroring.
4. Confirm account-level deletion semantics against a real account. Dofek's
   disconnect-before-erasure gate is covered by the existing real-Postgres
   account-erasure regression, and the provider never calls account-wide revoke.

## Implemented in Dofek

The provider composes the shared `ClimbingBoardAccount` graph persistence,
retrieves a full snapshot for each of the nine supported board types, and
reconciles only after all responses validate. It keeps each source tick and maps
only the returned personal grade label. After reading the authoritative ticks,
it pages `userAscentsFeed` with both sends and attempts to enrich exact tick/climb
identities with names. The feed does not control deletion or completeness.
For a recorded board ID, `tickBoardOptions.currentBoard` resolves its accessible
UUID, and `board(boardUuid)` supplies the physical board and available location.
Locations belong to the log entry, since the same problem can be climbed on
different boards. Inaccessible boards and absent locations remain unknown;
enrichment responses are retained alongside the original tick in `raw.metadata`.
These reads follow the upstream [ascent feed][tick-queries],
[current-board resolver](https://github.com/boardsesh/boardsesh/blob/main/packages/backend/src/graphql/resolvers/ticks/board-options.ts),
and [board projection](https://github.com/boardsesh/boardsesh/blob/main/packages/backend/src/graphql/resolvers/social/boards.ts).

The original `climbedAt` supplies the card timestamp and chart annotation on both
clients. Zone-less timestamps represent UTC in the upstream
[tick query](https://github.com/boardsesh/boardsesh/blob/main/packages/backend/src/graphql/resolvers/ticks/queries.ts).
The provider does not call the account-wide native revoke endpoint.
Apple/Google-only accounts need a BoardSesh email/password connection. These
constraints match the pinned
[native auth handler](https://github.com/boardsesh/boardsesh/blob/af2f7adf95eac77990b91da8d254d97ead25b938/packages/backend/src/handlers/native-auth.ts),
[tick schema](https://github.com/boardsesh/boardsesh/blob/af2f7adf95eac77990b91da8d254d97ead25b938/packages/shared-schema/src/schema/ticks.ts),
and [tick query resolver](https://github.com/boardsesh/boardsesh/blob/af2f7adf95eac77990b91da8d254d97ead25b938/packages/backend/src/graphql/resolvers/ticks/queries.ts).

The shared provider catalog uses the official
[BoardSesh app icon](https://github.com/boardsesh/boardsesh/blob/main/packages/mobile/assets/icon.png)
for web and mobile, including source labels without an external climb link.

[mobile-auth]: https://github.com/boardsesh/boardsesh/blob/af2f7adf95eac77990b91da8d254d97ead25b938/packages/mobile/src/lib/auth.ts
[env]: https://github.com/boardsesh/boardsesh/blob/af2f7adf95eac77990b91da8d254d97ead25b938/packages/mobile/src/lib/env.ts
[graphql-client]: https://github.com/boardsesh/boardsesh/blob/af2f7adf95eac77990b91da8d254d97ead25b938/packages/mobile/src/lib/graphql/client.ts
[native-auth]: https://github.com/boardsesh/boardsesh/blob/af2f7adf95eac77990b91da8d254d97ead25b938/packages/backend/src/handlers/native-auth.ts
[yoga]: https://github.com/boardsesh/boardsesh/blob/af2f7adf95eac77990b91da8d254d97ead25b938/packages/backend/src/graphql/yoga.ts
[refresh-client]: https://github.com/boardsesh/boardsesh/blob/af2f7adf95eac77990b91da8d254d97ead25b938/packages/mobile/src/lib/auth-interceptor.ts
[sync]: https://github.com/boardsesh/boardsesh/blob/af2f7adf95eac77990b91da8d254d97ead25b938/packages/backend/src/graphql/resolvers/sync/queries.ts
[sync-schema]: https://github.com/boardsesh/boardsesh/blob/af2f7adf95eac77990b91da8d254d97ead25b938/packages/shared-schema/src/schema/sync.ts
[sync-validation]: https://github.com/boardsesh/boardsesh/blob/af2f7adf95eac77990b91da8d254d97ead25b938/packages/backend/src/validation/schemas/sync.ts
[sync-manifest]: https://github.com/boardsesh/boardsesh/blob/af2f7adf95eac77990b91da8d254d97ead25b938/docs/sync-table-manifest.md
[ticks]: https://github.com/boardsesh/boardsesh/blob/af2f7adf95eac77990b91da8d254d97ead25b938/packages/shared-schema/src/schema/ticks.ts
[tick-queries]: https://github.com/boardsesh/boardsesh/blob/af2f7adf95eac77990b91da8d254d97ead25b938/packages/backend/src/graphql/resolvers/ticks/queries.ts
[retention]: https://github.com/boardsesh/boardsesh/blob/af2f7adf95eac77990b91da8d254d97ead25b938/packages/shared/offline-sync/src/sync/retention.ts
[integration-platform]: https://github.com/boardsesh/boardsesh/blob/af2f7adf95eac77990b91da8d254d97ead25b938/docs/integration-platform.md
[legal]: https://github.com/boardsesh/boardsesh/blob/af2f7adf95eac77990b91da8d254d97ead25b938/LEGAL.md
[partner-api]: https://github.com/boardsesh/boardsesh/blob/af2f7adf95eac77990b91da8d254d97ead25b938/docs/partner-api.md
