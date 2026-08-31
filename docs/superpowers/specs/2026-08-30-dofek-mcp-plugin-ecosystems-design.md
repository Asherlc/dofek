# Dofek MCP Plugin Ecosystem Distribution Design

**Date:** 2026-08-30  
**Status:** Approved for implementation  
**Product:** Dofek, operated by Asher Cohen

## Purpose

Make Dofek's authenticated health-data MCP server a trustworthy, discoverable
integration across the curated AI ecosystems that support remote MCP servers.
The release includes an interactive ChatGPT plugin experience for exploring a
user's own health data, while keeping the same read-only query tools useful in
Claude, Cursor, Codex, VS Code, and other MCP-capable clients.

This design deliberately avoids generic directory spam. Distribution targets
are the OpenAI Plugin Directory, Anthropic's Connectors Directory, the official
MCP Registry, and Cursor Marketplace. Other compatible clients receive
first-party installation documentation rather than duplicate listings.

## Product and publisher identity

- **Product name:** Dofek.
- **Legal publisher and operator:** Asher Cohen, acting as an individual rather
  than through a registered business.
- **Canonical public origin:** `https://dofek.fit`.
- **Canonical remote MCP endpoint:** `https://dofek.fit/api/mcp`.
- **Privacy and terms:** public Dofek pages that identify Asher Cohen as the
  operator and explain OAuth-authorized sharing of health data with an AI
  client.

`dofek.fit` is the single production origin used for server metadata, OAuth
protected-resource metadata, OAuth authorization server metadata, redirect and
audience validation, registry records, OpenAI submission, and documentation.
Production deployments must keep `PUBLIC_URL=https://dofek.fit`; an overridden
production origin is invalid because OAuth resource and token audiences require
the exact canonical URL.
The retired `dofek.asherlc.com` origin must not remain a parallel public MCP or
OAuth identity. OpenAI's publication process locks a plugin's production
origin, making this migration a prerequisite for submission.

## User experience

### Analytics Explorer (ChatGPT)

Dofek ships a full MCP App named **Analytics Explorer**. A user can connect
Dofek with OAuth, ask ChatGPT for a health trend or summary, and open an
interactive explorer that renders the server-provided result.

The explorer provides:

- date-range and metric selection;
- KPI cards for the selected range;
- trend and distribution charts using the repository's existing ECharts stack;
- source-coverage and missing-data cues; and
- plain-language, descriptive labels only.

It is an analytical display, not a diagnostic or treatment tool. It must not
claim medical conclusions, make recommendations, or compute health scores in
the browser.

### Other MCP clients

Clients that do not render MCP Apps remain fully supported. They use the
existing, independently meaningful tool responses and can invoke the same
read-only data tools through the Dofek OAuth flow. The Explorer render tool
returns useful textual content in addition to its structured UI payload.

## Architecture

### MCP service and data boundary

The existing Streamable HTTP MCP server remains the only data boundary. The
MCP server authenticates the user using Dofek OAuth 2.1 and derives all data
access from the access-token subject. Every repository query remains
user-scoped. No browser component calls a Dofek health API directly.

A new server-side analytics-explorer service composes a normalized snapshot
from the existing domain queries and formatting utilities. It returns every
value necessary to render charts and cards; the client may format, label,
filter ephemeral view state, and lay out data, but may not derive or aggregate
metrics.

### Tools

Existing health query tools continue to expose their current focused domains:

- daily health summary and health trends;
- sleep, activities, finger loading, nutrition, body metrics, and subjective
  timeline;
- provider inventory.

All query tools, plus the new `render_health_explorer` tool, explicitly declare
`readOnlyHint: true`. They return a stable structured payload as well as
human-readable MCP content where a structured payload is useful.

`start_provider_sync` remains the sole mutable tool. It is not marked
read-only, clearly communicates that it queues a provider synchronization, and
retains its existing authorization and user scope.

`render_health_explorer` accepts a bounded date range and selected analytic
view/metric. It validates the request, invokes the server analytics-explorer
service, returns a concise summary and `structuredContent`, and references the
Explorer resource URI. It never mutates user data.

### MCP App resource

The Explorer is a dedicated React static resource registered at
`ui://dofek/health-explorer.html` with MIME type
`text/html;profile=mcp-app`. It uses the MCP Apps bridge to receive tool
results and request another server-mediated render when users change filters.

The resource is bundled with the server deployment rather than served from an
unversioned third-party origin. Its Content Security Policy permits only the
specific resource and asset connections needed by the app; it does not allow
arbitrary network connections, inline remote scripts, or direct health-data
fetches. The app follows OpenAI's MCP App resource and UI metadata conventions.
[OpenAI MCP Apps UI guide](https://developers.openai.com/plugins/build/chatgpt-ui)

The new frontend package uses the repository's established React and ECharts
stack. No second charting library is introduced.

### Deployment and OAuth migration

Production configuration, deploy manifests, and workflow defaults move from
`dofek.asherlc.com` to `dofek.fit`. The deployed service must expose matching
protected-resource metadata at:

`https://dofek.fit/.well-known/oauth-protected-resource/api/mcp`

That metadata names `https://dofek.fit/api/mcp` as its resource and the
canonical Dofek authorization server. OAuth discovery, authorization,
registration, token exchange, and audience checks use the same canonical
identity.

No new environment variables are required unless the existing deployment model
cannot express the canonical public URL; if one is necessary, it must be added
to Infisical before deployment.

## Privacy, safety, and review access

The privacy and terms pages will:

- identify Dofek as operated by Asher Cohen;
- describe the categories of health data Dofek processes;
- explain that a user who authorizes an AI client permits that client to receive
  the results of the tools it requests; and
- link users to Dofek support.

The release does not expose one user's data to another user, publish health
data, infer medical conditions, or create a public demo dataset.

OpenAI review requires a testable account. A separate synthetic-data review
account, with no MFA, is created as a one-time, production operator action.
It must not use a real person's data and must not use the local `pnpm seed`
fixture or any script that can target production.

## Distribution deliverables

### OpenAI Plugin Directory (ChatGPT and Codex)

Submit the interactive MCP App through the OpenAI Plugin Directory. The
submission includes production MCP metadata, tool schemas and annotations,
Explorer screenshots, square logo, privacy and terms URLs, focused test
prompts/responses, support contact, and synthetic review credentials.

The production endpoint is scanned and then submitted from the OpenAI plugin
portal. Any portable package artifacts follow the documented plugin manifest
format and refer to the portal-created plugin app identifier rather than
inventing a permanent identifier.
[OpenAI plugin submission guide](https://developers.openai.com/plugins/deploy/submission)
[OpenAI app review requirements](https://developers.openai.com/plugins/deploy/app-review)

### Anthropic Connectors Directory

Submit Dofek's remote connector with the canonical endpoint, OAuth flow,
publisher identity, privacy/terms/support information, and a clear statement
that it provides user-authorized personal health-data analysis. It must satisfy
the Connector Directory policy and review process.
[Anthropic MCP Directory FAQ](https://support.anthropic.com/en/articles/11596036-anthropic-mcp-directory-faq)
[Anthropic MCP Directory policy](https://support.anthropic.com/en/articles/11697096-anthropic-mcp-directory-policy)

### Official MCP Registry

Publish the remote server through the official MCP Registry with public
`server.json` metadata, canonical endpoint, publisher verification, versioned
release metadata, and Dofek documentation. The recommended registry identity
is the verified GitHub namespace for Asher Cohen unless DNS verification offers
a clearly better permanent namespace.
[MCP Registry overview](https://modelcontextprotocol.io/registry/about)
[MCP Registry quickstart](https://modelcontextprotocol.io/registry/quickstart)

### Cursor Marketplace

Cursor Marketplace requires marketplace plugins to be open source. Dofek's
main repository remains proprietary, so Cursor receives a separate public
`dofek-mcp-plugin` repository under the MIT license. It contains only:

- the Cursor `plugin.json` and remote-MCP `mcp.json` configuration;
- non-proprietary installation, authentication, and capability documentation;
- general-purpose, non-proprietary skill guidance; and
- links to Dofek's public support, privacy, and terms pages.

It contains no Dofek server, frontend, database, product, or customer-data
source code. The repository is validated, made public, and submitted to
Cursor's Marketplace after the canonical endpoint is live.
[Cursor plugins reference](https://cursor.com/docs/reference/plugins)
[Cursor Marketplace publisher terms](https://cursor.com/marketplace-publisher-terms)

### First-party installation documentation

Dofek documentation explains how to connect the canonical remote server in
Claude, Codex, ChatGPT developer mode, Cursor, GitHub Copilot/VS Code, and any
standards-compatible MCP client. It distinguishes the full Explorer UI
(supported by hosts that implement MCP Apps) from the universally available
read-only tools.

## Validation and release gates

Implementation follows test-driven development.

1. Add failing unit/component tests for tool annotations, structured explorer
   payloads, request validation, resource metadata/CSP, and Explorer bridge
   rendering before implementation.
2. Build, typecheck, lint, and run the affected test tiers. Exercise any
   database behavior with real integration tests when query semantics change.
3. Deploy the canonical `dofek.fit` configuration and verify the actual MCP
   endpoint, OAuth protected-resource discovery, dynamic client registration,
   consent flow, token exchange, and user isolation.
4. Use MCP Inspector and real client connection flows: ChatGPT developer mode
   for the Explorer and Claude custom connector configuration for the
   interoperable tool path.
5. Produce truthful OpenAI review screenshots and test prompts using only the
   synthetic review account. Scan tools and resolve actionable metadata or
   safety findings before review submission.
6. Validate MCP Registry metadata using its official tooling and validate the
   Cursor companion repository using Cursor's documented plugin requirements.
7. Submit each external form or publication only when its account access,
   verification, and review credentials are available. Each final submission is
   an externally visible action and is confirmed at the action point.

## Out of scope

- Health diagnosis, treatment, medical advice, or automated recommendations.
- New health-data computations in a browser or mobile client.
- Publishing the proprietary Dofek product source to satisfy Cursor.
- Generic third-party directory submissions without an official, curated review
  process.
- Seeding or modifying production data through local development fixture
  scripts.
