# Ziva nutrition provider

<!-- cspell:ignore Ziva -->

Ziva is a read-only nutrition source in Dofek. Users authorize their own Ziva
account through Settings → Data Sources; scheduled sync imports saved diary
meals as canonical meal aggregates. Dofek never asks an LLM to interpret the
response and never calls Ziva's meal-write or delete tools.

Ziva publishes its stateless MCP endpoint and tool catalog in the
[Ziva MCP API reference](https://ziva.fit/mcp-docs). Ziva currently describes
the service as free, with no paid tiers or Ziva usage limits, on its
[pricing page](https://ziva.fit/pricing). Dofek uses the official
[Model Context Protocol TypeScript SDK v1](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x)
for Streamable HTTP rather than implementing the protocol itself.

## OAuth and application registration

The public
[protected-resource metadata](https://connect.ziva.fit/.well-known/oauth-protected-resource/mcp)
identifies `https://connect.ziva.fit/mcp` as the protected resource. The public
[authorization-server metadata](https://connect.ziva.fit/.well-known/oauth-authorization-server)
advertises authorization-code and refresh-token grants, S256 PKCE, dynamic
client registration, and `client_secret_post`; it does not advertise token
revocation or introspection.

The following additional facts are dated direct observations from the
authorization and read-only verification performed on 2026-09-20. They are not
claims that Ziva's public documentation publishes a token or response schema:

- authorization required state, S256 PKCE, and
  `resource=https://connect.ziva.fit/mcp`, while an empty scope list required
  omitting the `scope` parameter;
- an access token was a JWT with issuer `https://connect.ziva.fit/`, audience
  `https://connect.ziva.fit/mcp`, a stable non-empty `sub`, and a 3,600-second
  lifetime;
- unattended refresh succeeded, rotated both access and refresh tokens, and
  kept the same subject; and
- the metadata exposed no revocation endpoint.

Dofek stores each user's encrypted access token, refresh token, expiry, and
verified `sub` separately. `ZIVA_CLIENT_ID` and `ZIVA_CLIENT_SECRET` are
application credentials only; never put a user bearer or refresh token in
deployment configuration. Production key names were verified present in
Infisical on 2026-09-20 without reading or recording their values. See the
[production secrets procedure](../deploy/README.md#production-secrets).

### Dynamic client registration

The sanitized 2026-09-20 registration probe followed the registration endpoint
from the
[authorization-server metadata](https://connect.ziva.fit/.well-known/oauth-authorization-server)
and used this exact production request:

```http
POST https://connect.ziva.fit/register
Content-Type: application/json

{
  "client_name": "Dofek",
  "redirect_uris": ["https://dofek.fit/callback"],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "client_secret_post"
}
```

A different deployment must replace `https://dofek.fit/callback` with that
deployment's exact normal public Dofek callback before registration. The
registered URI and Dofek's configured callback must match exactly. Store the
returned client ID and secret as `ZIVA_CLIENT_ID` and `ZIVA_CLIENT_SECRET` in
the deployment's secret manager. Dofek's deployment allowlist supplies them to
the web service, which handles OAuth callbacks, and the worker, which syncs;
unrelated services do not receive them.

## Connect, reconnect, and disconnect

1. Open **Settings → Data Sources**, choose **Ziva**, and select **Connect**.
2. Complete Ziva's authorization page. Dofek validates OAuth state, uses S256
   PKCE, and stores the encrypted account-scoped authorization.
3. If the provider reports that authorization needs attention, open Ziva and
   select **Reconnect**. A reconnect replaces the stored authorization for that
   Dofek user.
4. To stop future syncs, open Ziva's provider detail and use **Disconnect** in
   the danger zone. Disconnect deletes Dofek's connection and credentials but
   retains previously imported records, matching other providers.

Because the
[authorization-server metadata](https://connect.ziva.fit/.well-known/oauth-authorization-server)
advertises no revocation endpoint, Dofek cannot claim that Disconnect revokes
the server-side Ziva grant. An active Ziva connection therefore blocks Dofek
account-erasure confirmation: disconnect Ziva in Dofek first, then begin
account deletion.

## Verified diary read contract

Ziva's public reference names `get_meals_for_date` and describes date or range
retrieval, but does not publish its exact result schema
([Ziva MCP API reference](https://ziva.fit/mcp-docs)). A direct authenticated,
read-only observation on 2026-09-20 found:

- `tools/list` exposed `get_meals_for_date` as read-only, non-destructive, and
  closed-world, with nullable `start_date` and `end_date` date inputs;
- a populated single-date call and an empty single-date call succeeded;
- a same-day `start_date`/`end_date` pair succeeded; and
- an authenticated range spanning two dates returned MCP `isError`.

Successful multi-day retrieval is therefore unsupported by Dofek, not merely
untested. Dofek sends exactly one `start_date` and no `end_date` per request.

The user's only logged record at verification time was one meal containing one
item. The observed meal keys were `mealId`, `description`, `mealDate`,
`mealType`, nullable `mealTime`, `createdAt`, `itemCount`, `items`, and
meal-level `macros`. The one item exposed `food`, `portion`, `quantity`, and
nullable `gramWeight`. It did not expose a stable item ID, database-food ID, or
portion ID. Multi-item behavior has only synthetic resilience coverage; it was
not observed live.

The observed whole-meal macro object contained `calories`, `protein`, `carbs`,
and `fat`. Ziva documents calories and protein/fat/carbohydrate macros in its
[MCP reference](https://ziva.fit/mcp-docs) and
[product explanation](https://ziva.fit/how-it-works). The observed values and
dashboard used the dietary-calorie/macronutrient convention—kcal for calories
and grams for protein, carbohydrate, and fat—but the read contained no unit
fields. Dofek stores these meal totals directly, maps `carbs` to canonical
`carbohydrate`, and performs no scaling or conversion. Item quantity, portion,
and gram weight never rescale the totals.

The verified read did **not** expose:

- fiber, micronutrients, or per-item nutrient values;
- explicit nutrient unit fields;
- item, database-food, or portion identifiers;
- pagination or a cursor;
- a completeness marker;
- an update timestamp; or
- a deletion marker or authoritative absence signal.

Repeated `dailyTargets` are goals, not intake, and returned `instructions` are
inert provenance. Dofek does not synthesize missing nutrients or infer support
from Ziva's broader write/search tools. Sanitized observed fixtures cover the
one-meal/one-item shape; explicitly labeled synthetic fixtures test malformed,
zero-macro, and multi-item resilience without claiming those shapes were seen.

## Sync and storage behavior

- Initial sync is bounded to 730 literal calendar dates. Work is divided into
  at most 14 single-date calls per continuation job.
- Explicit backfills keep their literal inclusive `YYYY-MM-DD` bounds. Dofek
  does not shift diary dates through UTC or a home timezone.
- A response must match its requested date, use unique non-empty meal IDs, and
  include finite nonnegative values for all four observed macro keys before
  any record is written or its checkpoint advances.
- The stable account namespace plus meal ID drives the source key. Re-reading
  an edited meal updates the same raw record and exact four-macro set.
- Existing Dofek edit and hide overlays survive a source re-sync. Connecting a
  different Ziva account cannot overwrite the former account's records; an
  overlapping day becomes a source conflict rather than an unsafe sum.
- A successful empty date advances that date's checkpoint but does not hide or
  delete a previously imported meal. The read lacks the completeness and
  deletion evidence needed to infer source absence.

## Read-only smoke command

Run the command only with an explicit UUID for a normally connected Dofek user
whose stored Ziva access token is still unexpired:

```bash
pnpm smoke:ziva -- --user-id "$DOFEK_ZIVA_SMOKE_USER_ID" --date 2026-09-20
```

The command parses both arguments before opening resources, decrypts that
user's stored token read-only, verifies the JWT issuer/audience/subject and
exact stored account identity, then uses the production MCP client for exactly
one date. It fails instead of refreshing an expired token. It never saves or
deletes credentials, writes nutrition, touches checkpoints or queues, or uses
the Redis-backed adaptive-rate store.

Output is one redacted JSON object containing only tool availability, meal
count, allowlisted field/macro-key availability, and booleans for meal ID, item
ID, and gram-weight presence. It contains no diary text, IDs, credentials,
claims, raw tool output, or nutrient amounts. A `gramWeight` key with a `null`
value still counts as present; an empty result provides no field evidence.
