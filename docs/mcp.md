# Remote MCP

Dofek exposes a remote Model Context Protocol endpoint at:

```text
https://dofek.fit/api/mcp
```

Production deployments must keep `PUBLIC_URL=https://dofek.fit`; OAuth resource and token audiences are exact canonical URLs, so an alternate production origin is invalid.

## Public-origin cutover precondition

Before retiring a previous production origin, an operator must migrate every active app-level provider webhook callback to `https://dofek.fit/api/webhooks/{provider}` and verify it with that provider. Callback registration is provider-owned external state: some providers expose an API while others require their provider portal, so Dofek intentionally does not attempt a generic automatic re-registration. Retire the previous origin only after each active callback has been verified at the canonical endpoint.

The endpoint uses Streamable HTTP and supports two authentication paths:

- OAuth 2.1 authorization code with PKCE for remote MCP clients (Claude, ChatGPT, and any other client that supports OAuth auto-discovery).
- Manually created MCP bearer tokens for clients or deployments configured with a static `Authorization` header.

Remote MCP authorization uses OAuth 2.1 discovery, protected-resource metadata ([RFC 9728](https://www.rfc-editor.org/rfc/rfc9728)), exact redirect URI matching, short-lived access tokens, rotating refresh tokens, and per-tool scopes as required by the [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).

## Connect With OAuth

Dofek supports [OAuth Client ID Metadata Documents (CIMD)](https://modelcontextprotocol.io/seps/991-enable-url-based-client-registration-using-oauth-c) and [OAuth Dynamic Client Registration (DCR)](https://www.rfc-editor.org/rfc/rfc7591). Configure the client with only:

```text
MCP URL: https://dofek.fit/api/mcp
```

In Claude, select **Use Anthropic’s hosted client metadata**. Claude then uses its HTTPS metadata URL as the OAuth client ID rather than registering a client. Dofek accepts only public HTTPS metadata hosts, rejects redirects and oversized responses, validates the exact client ID and callback URLs, and caches only validated documents. This is the MCP-recommended client-registration mechanism. [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)

### CIMD token authentication negotiation

Dofek supports the public-client `none` token endpoint authentication method for CIMD. When a client metadata document includes `token_endpoint_auth_methods_supported`, Dofek selects `none` from that list and uses it even if the legacy singular `token_endpoint_auth_method` names another method. A document whose plural list excludes `none` is rejected. When the plural field is absent, Dofek preserves the legacy behavior: a missing singular field or `none` is accepted, while another singular method is rejected.

ChatGPT’s CIMD transition publishes the plural method list as capabilities and retains the singular field only as a legacy preference; it instructs authorization servers to select a method from the supported intersection. [OpenAI client registration guidance](https://developers.openai.com/plugins/build/auth/#client-registration) The applicable IETF CIMD draft defines URL-hosted client metadata, its exact client ID match, and how a client can declare `private_key_jwt` with a published JWKS when an authorization server supports that method. [IETF Client ID Metadata Document §4 and §8.2](https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/)

For clients that do not support CIMD, leave the OAuth Client ID and OAuth Client Secret fields empty to use DCR. The client discovers `/register` ([RFC 7591 §3](https://www.rfc-editor.org/rfc/rfc7591#section-3)), registers itself, and stores the resulting client credentials. Each registration receives a unique client ID and secret; Dofek encrypts the secret at rest with `CREDENTIAL_ENCRYPTION_KEY_BASE64` using the [AWS Encryption SDK](https://docs.aws.amazon.com/encryption-sdk/latest/developer-guide/introduction.html) raw AES-256-GCM keyring ([`@aws-crypto/client-node`](https://github.com/aws/aws-encryption-sdk-javascript); see [credential encryption](credential-encryption.md)). Registration secrets expire after 30 days via `client_secret_expires_at` ([RFC 7591 §3.2.1](https://www.rfc-editor.org/rfc/rfc7591#section-3.2.1)).

The client redirects each user to Dofek to sign in and approve the requested scopes. Access tokens expire after one hour. Refresh tokens expire after 30 days and rotate on every use; reusing an older refresh token fails ([OAuth 2.0 Security BCP refresh token rotation](https://www.rfc-editor.org/rfc/rfc9700#name-refresh-tokens); [RFC 6819 §5.2.2.3](https://www.rfc-editor.org/rfc/rfc6819#section-5.2.2.3)). The `/revoke` endpoint invalidates the complete access-and-refresh token pair ([RFC 7009](https://www.rfc-editor.org/rfc/rfc7009)).

Examples that use this path include [Claude remote connectors](https://support.claude.com/en/articles/11503834-building-custom-connectors-via-remote-mcp-servers) and [ChatGPT apps / connectors](https://developers.openai.com/apps-sdk/build/auth).

### Client-specific setup

Open Dofek **Settings → Advanced → MCP** on the web, or **Settings → Advanced**
in the mobile app. Both surfaces show the remote URL and provide these setup
actions:

- **Claude:** **Connect Claude** opens Anthropic's custom-connector form with
  the Dofek name and URL prefilled. Review the connection and authorize Dofek
  when prompted. Anthropic documents custom remote connectors and their OAuth
  flow in the [Claude connector guide](https://claude.com/docs/connectors/building/directory-vs-custom).
- **ChatGPT:** **Copy for ChatGPT** copies the endpoint. In the ChatGPT desktop
  app, open **Settings → MCP servers → Add server**, select Streamable HTTP,
  paste the URL, save, restart, and authenticate. ChatGPT web uses published
  plugins rather than the desktop app's local MCP configuration
  ([OpenAI MCP documentation](https://learn.chatgpt.com/docs/extend/mcp.md)).
- **Cursor:** **Add to Cursor** opens Cursor's documented MCP install deeplink
  containing `{ "url": "https://dofek.fit/api/mcp" }`; Cursor shows the
  configuration for review before installation and OAuth
  ([Cursor MCP install links](https://cursor.com/docs/mcp/install-links)).
- **VS Code:** **Add to VS Code** opens VS Code's documented
  `vscode:mcp/install` handler with a Streamable HTTP server definition. VS Code
  supports remote MCP OAuth and MCP Apps
  ([VS Code MCP developer guide](https://code.visualstudio.com/api/extension-guides/ai/mcp)).

The **Other MCP clients** section provides copyable setup for clients without a
website install link:

```bash
claude mcp add --transport http --scope user dofek https://dofek.fit/api/mcp
```

Claude Code recommends remote HTTP for cloud services and starts OAuth from its
`/mcp` interface when the server requires authentication
([Claude Code MCP documentation](https://code.claude.com/docs/en/mcp)).

```bash
codex mcp add dofek --url https://dofek.fit/api/mcp
codex mcp login dofek
```

Codex supports Streamable HTTP servers and OAuth through its shared MCP
configuration ([OpenAI MCP documentation](https://learn.chatgpt.com/docs/extend/mcp.md)).

```bash
gemini mcp add dofek https://dofek.fit/api/mcp --transport http --scope user
```

Gemini CLI documents the HTTP transport and user-scoped MCP configuration in
its [CLI reference](https://geminicli.com/docs/cli/cli-reference/).

For Windsurf, paste this into its MCP raw configuration and refresh the MCP
list:

```json
{
  "mcpServers": {
    "dofek": {
      "serverUrl": "https://dofek.fit/api/mcp"
    }
  }
}
```

Windsurf supports Streamable HTTP and OAuth, and documents `serverUrl` for
remote HTTP servers in its [Cascade MCP guide](https://docs.windsurf.com/windsurf/cascade/mcp).

### Redirect URI policy

Registrations may use any absolute `https://` callback URL. `http://` is allowed only for loopback hosts (`localhost`, `127.0.0.1`, `::1`) so local MCP clients can complete OAuth during development ([OAuth 2.1](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-13#section-9.7); [RFC 8252 §7.3](https://datatracker.ietf.org/doc/html/rfc8252#section-7.3)). Fragments, embedded credentials, and non-HTTPS remote URLs are rejected. Authorization and token exchange still require exact redirect URI matching against the registered value ([OAuth 2.0 Security BCP §4.1.3](https://www.rfc-editor.org/rfc/rfc9700#section-4.1.3)).

OAuth discovery and protocol endpoints ([MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization); [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728); [RFC 8414](https://www.rfc-editor.org/rfc/rfc8414); [RFC 7591](https://www.rfc-editor.org/rfc/rfc7591); [RFC 7009](https://www.rfc-editor.org/rfc/rfc7009)):

```text
/.well-known/oauth-protected-resource/api/mcp
/.well-known/oauth-authorization-server
/register
/authorize
/token
/revoke
```

## Create A Token

Tokens are only needed when a client is configured to use manual bearer-token authentication. OAuth-based clients authenticate automatically.

Open Dofek web Settings, select **Advanced**, and use the **MCP** section to create, copy, list, and revoke tokens.

The UI calls the authenticated tRPC `mcp.createToken` procedure from the logged-in Dofek client session.

Input:

```json
{
  "name": "Codex",
  "scopes": ["health:read", "health:write", "activity:read", "nutrition:read", "providers:read", "sync:write"],
  "expiresAt": null
}
```

The response includes `token` once. Store it in the MCP client. Dofek stores only a hash.

List existing token metadata with `mcp.listTokens`. Revoke a token with `mcp.revokeToken`.

`nutrition:write` is an explicit opt-in. It is not selected by default when a
manual token is created, and OAuth's default scope request omits it. Existing
manual tokens and OAuth grants keep their stored scopes. To add food-record
write access, create a new manual token with **Modify food records** selected,
or reauthorize the OAuth client with `nutrition:write` in its requested scopes.
Granting that scope does not change the other default scopes.

## Scopes

| Scope | Allows |
|-------|--------|
| `health:read` | Read daily health summaries. |
| `health:write` | Log user-owned health observations such as injuries. |
| `activity:read` | Search activity summaries. |
| `nutrition:read` | Read daily nutrition summaries and effective food records. |
| `nutrition:write` | Create, update, delete, and restore food records; also requires `nutrition:read`. |
| `providers:read` | List configured providers and connection status. |
| `sync:write` | Enqueue provider sync jobs. |

`health:write` is never granted by default. Manual-token users must select it,
and OAuth clients must request it explicitly.

## Tools

The canonical tool names, schemas, and scope checks are defined in the [MCP tool implementation](../packages/server/src/mcp/tools.ts).

| Tool | Scope | Purpose |
|------|-------|---------|
| `get_daily_health_summary` | `health:read` | Returns server-computed metrics for one date. |
| `get_health_trends` | `health:read` | Returns a structured daily or weekly metric envelope with explicit no-data diagnostics, per-series coverage, and baseline-relative recovery context. |
| `get_data_coverage` | `health:read` | Returns first/last observed dates, observed-day counts, and providers for every supported health metric. |
| `render_health_explorer` | `health:read` | Returns a server-computed analytics snapshot and renders the Dofek Analytics Explorer in MCP clients that support Apps UI resources. |
| `get_sleep_summary` | `health:read` | Returns nightly sleep duration, efficiency, stages, and timing. |
| `search_activities` | `activity:read` | Searches activities inside exact date boundaries. |
| `get_activity_details` | `activity:read` | Returns one activity with its strength, climbing, and finger-loading details. |
| `get_activity_streams` | `activity:read` | Returns a capped, downsampled activity sensor stream with caller-selected channels. |
| `get_activity_summary` | `activity:read` | Aggregates activity volume and effort by type, ISO week, modality, or purpose, including unclassified and power coverage. |
| `get_cycling_performance` | `activity:read` | Returns exact-range per-ride normalized power, intensity factor, standard best efforts, rolling-90-day bests, FTP estimates, elevation, and coverage. |
| `get_training_load` | `activity:read`; also `nutrition:read` when requested | Returns daily load and rolling windows; analytical detail preserves modality channels and can include aligned nutrition. |
| `get_recovery_training_series` | Scope depends on selected streams: `health:read`, `activity:read`, and/or `nutrition:read` | Returns a selected, date-aligned recovery, sleep, weight, load, subjective, compact activity-exposure, and nutrition series without causal interpretation. |
| `compare_performances` | `activity:read` | Compares only explicitly or strongly evidenced equivalent workouts, routes, climbs, strength exercises, or standardized tests with contextual deltas and provenance. |
| `get_climbing_sessions` | `activity:read` | Returns exact-range climbing sessions with grades, attempts, sends, discipline, wall angle, and explicit unavailable fields. |
| `get_climbing_progression` | `activity:read` | Returns longitudinal climbing grade, attempt, send-rate, frequency, rolling-exposure, duplicate, and provenance analysis. |
| `get_finger_loading` | `activity:read` | Returns structured finger-loading protocols, effective load, and total time under tension inside exact date boundaries. |
| `get_finger_loading_progression` | `activity:read` | Returns longitudinal finger-load detail, explicit-threshold high-intensity days, consecutive exposure, and provenance as a separate load channel. |
| `get_strength_sessions` | `activity:read` | Returns high-level exact-range strength sessions and aggregates. |
| `get_strength_progression` | `activity:read` | Returns normalized set history, original provider values, anomaly exclusions, Epley e1RM/PR evidence, volume trends, and frequency. |
| `get_nutrition_summary` | `nutrition:read` | Returns a daily date spine of calorie, macronutrient, fiber, and meal totals with source resolution and logging-completeness status. |
| `search_food_entries` | `nutrition:read` | Searches effective food records by inclusive date range, optional text, and visibility. |
| `get_food_entry` | `nutrition:read` | Returns one effective food record with its version, modifiability, normalized nutrients, source provider, and provenance. |
| `create_food_entry` | `nutrition:read` + `nutrition:write` | Creates one itemized Dofek food record. |
| `update_food_entry` | `nutrition:read` + `nutrition:write` | Appends scalar and normalized nutrient decisions to a food record. |
| `delete_food_entry` | `nutrition:read` + `nutrition:write` | Appends a deletion tombstone; this is the only food tool advertised as destructive. |
| `restore_food_entry` | `nutrition:read` + `nutrition:write` | Restores a deleted record while retaining its field and nutrient decisions. |
| `get_food_entry_history` | `nutrition:read` | Returns the paginated command and decision history for a food record. |
| `get_body_metrics` | `health:read` | Returns reconciled body metrics, value kinds, source values, and 7/28-day rolling weight statistics. |
| `get_subjective_timeline` | `health:read` | Returns recorded check-ins, symptoms, and injury events for an exact date range. |
| `list_body_regions` | `health:read` | Lists canonical body-region IDs and labels accepted by subjective health tools. |
| `log_injury` | `health:write` | Logs a private injury or niggle with onset, optional resolution and severity, description, and canonical body region. |
| `list_providers` | `providers:read` | Lists configured providers and status. |
| `start_provider_sync` | `sync:write` | Enqueues a provider sync job. |

### Food record lifecycle

The seven food-record tools use the exact schemas in
[`food-record-tools.ts`](../packages/server/src/mcp/food-record-tools.ts). Read
tools require `nutrition:read`. Every mutation requires both `nutrition:read`
and the opt-in `nutrition:write` scope.

`search_food_entries` requires `start_date` and `end_date`. Its optional
case-insensitive text query matches the effective food name, description,
category, and meal. `visibility` accepts `visible`, `deleted`, or `all` and
defaults to `visible`; use `deleted` or `all` to find a tombstoned record before
restoring it. Results sort by immutable `record_id` descending and use a
`{ record_id }` cursor, default to 50 items, and accept limits from 1 through
100. The date range filters current effective dates; a provider replacement
that moves a date within the range cannot move an identity across the cursor.
The query is defined in the [food record repository](../packages/server/src/repositories/food-record-repository.ts).
`get_food_entry` returns `null` when the authenticated user does not own the
requested record.

Each returned food record distinguishes its stable `record_id` from its current
raw `source_entry_id`. Stable identity is scoped by the authenticated user, the
`nutrition.food` domain, and the provider namespace. A provider record with a
non-empty external ID uses `external:<external_id>` and is modifiable even when
the provider later replaces its raw row. A record without an external ID uses
`row:<food_entry.id>`: it remains readable but returns `modifiable: false` and
cannot be updated, deleted, or restored safely. The source-key encoding is an
internal identity rule; callers use the returned UUID `record_id`.

Reads return effective scalar values, canonical nutrient IDs mapped to numeric
amounts or explicit `null`, the source provider, and provenance for every
scalar, visibility, and nutrient value. Provenance identifies `source` or
`human` origin and the human `change_id` where applicable. Scalar provenance
keys use the same snake-case names as the wire fields, such as `food_name`
and `serving_weight_grams`; nutrient keys use `nutrients.<nutrient_id>`
([transport mapping](../packages/server/src/mcp/food-record-tools.ts)). Provider raw rows
remain unchanged when a human updates, deletes, or restores a record. Create is
the exception only in the ordinary sense that it writes a new Dofek itemized
source row and its normalized nutrient facts once, then records the initial
ledger operation.

`update_food_entry` separates decisions that override source data from
decisions that resume following it. Values in `set` override scalar fields;
fields in `clear` follow the source value again. `nutrient_set` accepts a
non-negative amount or explicit `null`; `nutrient_clear` resumes following the
raw nutrient. A field or nutrient cannot appear in both forms, and an update
must contain at least one decision. `delete_food_entry` hides the effective
record and removes its contribution from canonical nutrition without deleting
the raw provider row. `restore_food_entry` makes the same effective record
visible again. `get_food_entry_history` returns ledger operations and recorded
field/nutrient decisions, newest first, with opaque pagination cursors. Each
cursor contains only an immutable change ID, which the query resolves within
the authenticated account and requested record. PostgreSQL compares the exact
stored `(recorded_at, change_id)` pair, preserving its
[microsecond timestamp precision](https://www.postgresql.org/docs/current/datatype-datetime.html)
and [row comparison ordering](https://www.postgresql.org/docs/current/functions-comparisons.html#ROW-WISE-COMPARISON).
It does not snapshot historical provider facts.

Human nutrient clears and explicit-null decisions retain provenance, but only
non-NULL effective amounts count toward legacy nutrition-grain classification
([effective nutrition views](../drizzle/0113_effective_food_records.sql)).
HealthKit write-back reads the canonical raw Dofek food rows and normalized
nutrient facts, so human corrections and tombstones affect effective nutrition
without changing export values ([export query](../packages/server/src/repositories/food-repository.ts)).

Create requires a UUID `request_id`; update, delete, and restore require UUID
`record_id` and `request_id` plus nullable UUID `expected_version`. A source
record with no human changes has `version: null`, so its first mutation must use
`expected_version: null`. Afterward, callers pass the version returned by the
latest read or mutation. A stale version produces `CONFLICT` with the current
version so the caller can read, reconcile, and retry.

Mutation idempotency combines the user-scoped request UUID with a SHA-256
fingerprint of the validated canonical payload and authenticated MCP client.
Replaying the identical request performs no second source/ledger write and no
second nutrition-cache invalidation. Create checks the durable receipt before
provider setup and performs no provider or connection writes on replay
([command repository](../packages/server/src/repositories/food-record-repository.ts)).
It returns the immutable
`{ change_id, resulting_version, replayed }` operation receipt, with
`replayed: true`, plus the current effective record. Reusing the UUID for a
different payload, operation, record, or client produces `CONFLICT`. The MCP
result intentionally omits the service's internal affected-date bookkeeping.

Food command errors use this stable JSON error contract:

| Code | Meaning and safe details |
|------|--------------------------|
| `NOT_FOUND` | The user-owned record does not exist; includes `record_id`. |
| `PRECONDITION_FAILED` | The source has no stable provider external ID and cannot be modified safely; includes `source_entry_id`. |
| `CONFLICT` | `expected_version` is stale, a concurrent successor won, or a request UUID was reused; includes `record_id` and nullable `current_version`. Read the record again before retrying. |
| `INVALID_ARGUMENT` | The command failed schema or decision validation; includes actionable `issues` with field paths and messages. |
| `ACCOUNT_ERASURE_ACTIVE` | Account deletion is active; wait for it to finish before changing food records. |

Unexpected failures are reported internally as new exceptions with fixed
operation labels, excluding original messages, causes, SQL, and parameters
([service](../packages/server/src/services/food-record-service.ts),
[MCP handler](../packages/server/src/mcp/food-record-tools.ts)). They return the safe
`INTERNAL_ERROR` code without database or stack details. Missing scopes remain
tool-level `insufficient_scope` authorization failures.

All food mutations advertise `idempotentHint: true`, `readOnlyHint: false`, and
`openWorldHint: false`. Create, update, and restore advertise
`destructiveHint: false`; delete alone advertises `destructiveHint: true`.
Search, get, and history advertise `readOnlyHint: true` and
`openWorldHint: false`. These hints follow the official [MCP tool annotation
contract](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#toolannotations).

## Output contract

Every Dofek MCP tool advertises an `outputSchema` and, on success, returns
matching `structuredContent`. MCP requires structured results to conform to an
advertised output schema, and recommends also returning serialized JSON in a
text content block for backwards compatibility ([MCP Tools specification,
2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#structured-content)).
OpenAI likewise treats schemas as user-facing tool metadata and recommends an
output schema for structured results ([OpenAI: Build an MCP
server](https://developers.openai.com/plugins/build/mcp-server#define-tools-from-user-goals)).

For ordinary tools, the declared schema and `structuredContent` use the
object-root envelope `{ "result": ... }`. This makes scalar, array, `null`,
and object natural results valid object-root tool outputs without changing the
existing pretty-printed JSON text in `content`. For example, an ordinary tool
that naturally returns an array exposes it as `structuredContent.result`, while
its text content remains the unwrapped formatted array.

`render_health_explorer` is the intentional exception: it advertises and
returns the direct shared health-explorer snapshot schema, rather than wrapping
that snapshot in `result`. Its Apps UI consumer parses that same snapshot
directly. `structuredContent` is the machine-readable result data, `content`
remains transcript-visible compatibility text, and component-only metadata is
kept in `_meta`, consistent with [OpenAI's MCP result
guidance](https://developers.openai.com/plugins/build/mcp-server#return-useful-results-without-ui).

The ChatGPT submission portal can continue to display its output-schema warning
until this source change is merged and deployed and the submission form refreshes
the live MCP tool metadata. Do not interpret the stale portal result as evidence
that the checked-in tool catalog lacks the contract above.

For Heart Rate Variability (HRV), resting heart rate, respiratory rate, and sleep
efficiency, `get_health_trends` includes `baseline_relative` on the matching
aggregate. The context contains the preceding 30-day mean, standard deviation,
z-score, sample count and coverage, plus the latest 7-day mean compared with the
preceding 28-day mean. The current day is excluded from its own 30-day baseline;
standard deviation and z-score remain `null` until at least two varied baseline
samples exist. See the canonical
[baseline-relative metric contract](../packages/server/src/contracts/baseline-relative-metrics.ts).

Requested health metrics are never silently omitted. A metric without samples in
the requested range is returned with `points: []`, `note: "no_data_in_range"`,
nullable summary values, and zero observed-day coverage. Missing daily points use
`null`; per-metric missing-date lists are capped at 30 with a separate truncated
count. The canonical behavior is implemented by the
[health-series builder](../packages/server/src/mcp/health-series-service.ts).

`get_body_metrics` reconciles weight, body-fat percentage, and BMI independently.
It first keeps the latest provider-attributed value for each metric and local
date, then selects the first non-null value by configured `body_priority`
(falling back to the general provider priority and then `100`). Its
`source_provider_by_metric` identifies each winner, while `sources` retains the
provider-level values and timestamps from provider-attributed raw samples. Weight is labeled
`direct` only when it is finite and positive. Because the canonical body sample does not retain a
composition measurement method, body-fat percentage is labeled `unknown`; lean mass derived from
weight and body-fat percentage is labeled `calculated_from_unknown_composition`. DEXA and consumer
BIA values therefore are not conflated or promoted by provider-name assumptions. Invalid weight
values remain in `sources` for provenance but cannot win reconciliation or enter a rolling mean. No
composition value is substituted for body weight. Each returned measurement day includes the arithmetic mean of observed
daily direct weights in its trailing 7- and 28-calendar-day windows plus the number of observed days
in each window; gaps are omitted from the mean rather than filled or changed to zero. See the
[body repository](../packages/server/src/repositories/body-repository.ts).

`get_nutrition_summary` returns every date in the requested range. A date with no records has null
energy/macros, zero meal count, and `logging_completeness: "no_logging"`. Supplement dose events do
not count as food logging even when their nutrients are present in the canonical total. A date with food or nutrition records is
`unknown_completeness`; no connected nutrition source currently supplies an explicit daily complete
or partial observation. Low energy intake is never used as a completeness heuristic.
`resolution_status` remains a separate
description of which overlapping nutrition source was selected, so completeness and source conflict
are not conflated. See the canonical [food repository](../packages/server/src/repositories/food-repository.ts).
Dense nutrition responses are bounded to 366 inclusive days; callers split longer histories into
date chunks. For one aligned response, call `get_training_load` with `detail: "analytical"` and
`include_nutrition: true`. That path requires both `activity:read` and `nutrition:read` and preserves
the independent modality load channels alongside the canonical nutrition resolution and completeness
fields.

`get_training_load` reads the canonical incremental `daily_strain` model. ACWR is
`null` until the 28-day chronic window is complete; each row reports the current
7-day and 28-day window coverage explicitly. See the
[daily-strain model](../analytics/models/read_models/daily_strain.sql) and
[training-load repository](../packages/server/src/repositories/training-load-repository.ts).
Analytical `get_training_load` preserves its existing analysis-timezone calendar contract and
labels that choice as `date_policy: "analysis_timezone"`.

`get_recovery_training_series` returns an inclusive local-calendar date spine capped at 366 days.
Callers select only the needed `health`, `sleep`, `body_weight`, `training_load`, `subjective`,
`activities`, and `nutrition` streams; nutrition is opt-in. Missing scalar observations remain null
and carry `missing` status. HRV, respiratory rate, and step provider attribution is explicitly
labeled as applying to the canonical daily row because the current daily view does not attribute
every scalar independently. Resting HR is separately labeled as calculated from canonical
deduplicated samples; its current read model does not expose contributing provider IDs. Sleep
retains onset/wake timestamps, selected session, stage coverage, providers, named timezone, UTC
offsets, and local-time source. Body weight distinguishes a direct measurement on that date from
same-day/interpolated/nearest direct-measurement evidence and includes 7/28-day rolling coverage.

Training load remains six separate modality-specific channels. Each response date also exposes the
immediately preceding local-calendar day's load channels, calculated by calendar date rather than a
fixed 24-hour subtraction, so load-to-next-day recovery alignment remains correct across daylight-
saving transitions. Subjective symptoms and active injuries are aligned by their recorded dates;
daily fatigue is explicitly unavailable because the canonical subjective schema does not record it.
Activities are returned as bounded daily aggregates rather than an unpaginated hydrated list. The
aggregate retains canonical activity IDs/providers and counts dates attributed from authoritative
named-zone/offset context separately from dates that required the analysis-timezone assumption.
Activity-ID evidence is capped at 100 IDs per day with the total count and truncation flag returned.
Duration is zero only on an observed empty day; a missing end or invalid interval makes the daily
duration null with partial/unavailable status and supported/total counts. Activity exposure and all
load channels use the same source-resolved start offset before falling back to analysis timezone.
Each load channel reports authoritative-activity and analysis-timezone-activity counts. The latter
counts activities intentionally grouped by the configured analysis timezone rather than by
provider/device-local source context. This source-context policy is explicitly selected by the
recovery endpoint and does not change the standalone analytical training-load tool's
analysis-timezone default.
Optional provider and modality filters apply to both activity exposure and all training-load
channels; other recovery streams remain unfiltered. Stream-specific authorization and dependencies
mean nutrition-only and subjective-only requests do not require the ClickHouse analytics store.
The endpoint's interpretation block states that these observations support association analysis but do not establish causality. See the
[series repository](../packages/server/src/repositories/recovery-training-series-repository.ts).

`compare_performances` requires either a canonical reference activity or an explicit equivalence
key. Reference activities may derive only a single identity for which Dofek currently has a strong
contract: a Peloton class ID, one exact climb composite (type, grade system/grade, route, and
location, and lead/top-rope state when recorded), or one normalized strength exercise ID. Explicit
Peloton class IDs use the same contracted provider identity. Provider-scoped cycling route names,
standardized-test activity name/provider type, and exact normalized activity names are caller
assertions labeled `user_asserted`. When no single strong identity exists, the tool refuses to
compare. Sport, duration, and effort similarity alone never establish equivalence.

Candidate activities come from canonical `fitness.v_activity`, preventing duplicate provider
workouts from being counted twice. Cycling power, heart rate, cadence, distance, elevation, and
sample coverage come from deduplicated `analytics.activity_summary_rows FINAL`; average activity
temperature is calculated from `analytics.activity_sensor_sample FINAL`. Numeric deltas are
candidate minus the requested reference or earliest in-range match. Missing values stay null.
Strength volume and Epley estimates exclude suspicious or conflicting sets. Exact cross-provider climbing
observations and strength sets are consolidated, while conflicting observations are excluded and
reported; climbing attempts and outcomes preserve partial/unavailable state and never produce exact
deltas unless both performances have complete coverage. Strength volume and estimated-1RM values
likewise report complete/partial/unavailable state, and their deltas require complete coverage in
both performances. Each performance includes bounded, source-record-level equivalence evidence.
Provider-reported moving duration is returned with raw
field/source evidence and remains null when providers conflict. Route context is claimed only for a
caller-asserted provider-scoped cycling name and provider type; Dofek does not claim an upstream
route identifier that its normalized ingestion contract does not expose. Fuzzy near matches are
explicitly not evaluated because similarity does not establish equivalence. Per-performance
equivalence evidence is capped at 100 records, moving
duration evidence at 20, and nested climbing source evidence at 20 IDs/providers; total counts and
truncation flags preserve coverage. Results use reference-bound stable keyset cursors and include
provider, member activity, timezone, quality, and deduplication provenance. The comparisons are
descriptive and make no causal claim.

Exact provider workout, route, segment, and standardized-test evidence is
materialized only by the dbt-owned `analytics.activity_effort_identity` model
from retained source payloads. The historical audit and scoped refresh procedure
is documented in the [activity effort identity runbook](activity-effort-identity-runbook.md).
It never treats a provider activity instance ID, a matching name, or an ordinary
workout best as proof of equivalence, and it does not make provider network
requests to fill gaps. MCP clients must report missing identity evidence as a
coverage limitation rather than infer an exact repeat; the [MCP specification's
tool guidance](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
likewise treats tools as explicit operations rather than hidden background work.

`get_cycling_performance` reads the deduped `cycling_activity` and
`activity_power_curve` models. Per-ride FTP is 95% of the best observed
20-minute effort in that ride's trailing 90-day window; intensity factor divides
normalized power by that contemporaneous estimate. Missing power remains
`null`, and both power and elevation aggregates report activity coverage. See the
[cycling-performance repository](../packages/server/src/repositories/cycling-performance-repository.ts).

`get_climbing_sessions` exposes the stored Kaya/file-import grade, attempt,
send, lead/top-rope, and wall-angle fields. Route height is not currently stored,
so `total_vertical_m` is explicitly `null`. `get_finger_loading` reports
effective load as `bodyweight_kg + external_load_kg` (a negative external load
represents assistance) and computes total time under tension as hold duration
times set count. See the [climbing repository](../packages/server/src/repositories/climbing-repository.ts)
and [finger-loading reader](../packages/server/src/repositories/climbing-training-log-repository.ts).

## Connect A Header-Capable Client

For MCP clients that support custom remote HTTP headers directly, configure the URL and a manually created bearer token:

```json
{
  "mcpServers": {
    "dofek": {
      "url": "https://dofek.fit/api/mcp",
      "headers": {
        "Authorization": "Bearer dofek_mcp_..."
      }
    }
  }
}
```

For clients that need a local bridge, use `mcp-remote`:

```bash
pnpm dlx mcp-remote https://dofek.fit/api/mcp --header "Authorization: Bearer dofek_mcp_..."
```

## Manual Verification

Use the official inspector during development:

```bash
pnpm dlx @modelcontextprotocol/inspector@latest
```

Set the transport to Streamable HTTP, URL to `https://dofek.fit/api/mcp`, and include the bearer token header.

## Directory Listings

Dofek publishes one remote Streamable HTTP endpoint. The [MCP Registry remote-server format](https://modelcontextprotocol.io/registry/remote-servers) requires that endpoint to be publicly accessible and records it in the `remotes` field. Version `0.1.0` of the checked-in [registry entry](../registry/dofek/server.json) is [active in the official MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.Asherlc%2Fdofek/versions/latest). ChatGPT plugin review also requires a verified individual or business identity, a production MCP URL, a support URL, policy URLs, accurate tool annotations, and reviewer-ready test credentials ([OpenAI submission requirements](https://developers.openai.com/plugins/deploy/submission)).

For other clients, use the OAuth setup above when the client supports remote MCP OAuth discovery, or the bearer-header configuration when it does not. Clients that support MCP Apps UI render `render_health_explorer`; other clients receive the same readable JSON snapshot.

## Local Axiom MCP

The repo `.mcp.json` also exposes an `axiom` MCP server for production log queries. It starts `mcp-server-axiom` through `npx` and derives `AXIOM_TOKEN`, `AXIOM_URL`, and `AXIOM_ORG_ID` from the authenticated local Axiom CLI config. The deployed collector routes application and infrastructure logs to `dofek-logs` ([source](../deploy/otel-collector-config.yaml)).

```bash
axiom auth status --no-spinner
```

If your current MCP client session does not show Axiom tools, restart the session so `.mcp.json` is reloaded. Until then, use the CLI directly:

```bash
axiom query "['dofek-logs'] | where _time > ago(24h) | search 'Slow query' | project _time, body | sort by _time desc | limit 50" -f json --no-spinner
```

## Local XcodeBuildMCP

The repository configures XcodeBuildMCP in both `.mcp.json` and
`.codex/config.toml` so supported agents can build, install, launch, inspect, and
capture logs from the iOS app:

```json
{
  "mcpServers": {
    "xcodebuildmcp": {
      "command": "pnpm",
      "args": ["dlx", "xcodebuildmcp@2.6.2", "mcp"]
    }
  }
}
```

Restart the agent session after cloning or changing the MCP configuration so
the tool catalog reloads. If the current session cannot expose dynamically added
MCP tools, the same package provides a CLI fallback:

```bash
pnpm dlx xcodebuildmcp@2.6.2 simulator list
```

Follow the upstream getting-started guide for prerequisites and tool names:
<https://www.xcodebuildmcp.com/#get-started>. Version 2.6.2 is pinned here and
in both repository MCP configurations so every client loads the reviewed tool
release.

## Auth Failures

Missing or invalid tokens return `401` with `WWW-Authenticate: Bearer`. Tokens without the required tool scope return a tool-level insufficient-scope error.
