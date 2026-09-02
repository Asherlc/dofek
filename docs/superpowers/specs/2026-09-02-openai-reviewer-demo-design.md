# OpenAI reviewer demo environment design

## Goal

Prepare the synthetic reviewer account `asherlc+openai-review@asherlc.com` for
an OpenAI Developer Mode demonstration. The fixture must cover 18–31 August
2026 and support the five approved MCP tool interactions through
`https://dofek.fit/api/mcp`, without accessing, copying, or displaying any
real health data.

## Scope and safety boundary

The production fixture operation is deterministic and idempotent. It resolves
only the review account by its exact email address, then creates or replaces
only records that carry explicit synthetic-review provenance. It must reject a
missing account and must not enumerate, read, or mutate other accounts.

The operation supplies:

- daily HRV and step samples for 18–31 August;
- sleep records for 25–31 August;
- multiple representative activities within 18–31 August; and
- connected provider records with deterministic last-sync timestamps.

The serving layer remains provider-agnostic. The synthetic data uses canonical
raw record shapes and provider attribution; no provider-estimated energy data
is introduced.

## MCP tool behavior

`render_health_explorer` returns a valid Apps SDK tool result:

- `structuredContent` conforms to the declared Explorer output contract and is
  concise enough for the model;
- `content` provides a concise textual result for transcript-only clients; and
- `_meta` contains only component-facing payload required by the Explorer,
  including its registered UI resource URI.

The Explorer reuses the existing server-side health-series service, requesting
the supplied HRV and steps metrics. It does not calculate health values in the
client.

Descriptions for the five approved tools directly name their intended outcome
and exact date-range use, so prompt selection has clear tool semantics:

- HRV and step trend → `get_health_trends`
- Analytics Explorer visualization → `render_health_explorer`
- sleep summary → `get_sleep_summary`
- activities in a date range → `search_activities`
- connected providers with last sync → `list_providers`

## Verification

Before implementation, add focused failing tests for the Apps SDK result
envelope and revised tool descriptors. The test suite will then prove the
correct tool registration, input schema, and meaningful synthetic responses.

After normal deployment, authenticate as the review account and call the
production MCP endpoint. Capture only the invoked tool names, status, and
synthetic result counts/ranges for each exact approved prompt. Do not record
tokens, credentials, or health data belonging to any other account.

The Apps SDK result contract follows OpenAI's Apps SDK tool-result guidance:
[`structuredContent` matches `outputSchema`, `content` is transcript-visible,
and `_meta` is component-only](https://developers.openai.com/plugins/reference#tool-results).
