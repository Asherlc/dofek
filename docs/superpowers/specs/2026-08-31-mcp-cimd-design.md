# MCP Client ID Metadata Documents Design

## Goal

Allow Claude and other compatible MCP clients to authenticate with Dofek using
OAuth Client ID Metadata Documents (CIMD), while retaining Dynamic Client
Registration (DCR) for older clients.

## Context

Claude completed Dofek's DCR request successfully but reported a connector
registration error afterwards. CIMD avoids that DCR path: the client uses its
hosted HTTPS metadata URL directly as `client_id`, and Dofek resolves the
metadata for the OAuth flow. MCP recommends CIMD and retains DCR only as a
compatibility option. [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)

## Chosen Approach

Upgrade `@modelcontextprotocol/sdk` from `1.29.0` to the current stable
`1.30.0`, add the current stable `ipaddr.js` `2.5.0` for tested IPv4/IPv6
range classification, then add a Dofek-owned client resolver that composes the
existing database-backed DCR store with CIMD resolution.

The resolver will:

1. Use the stored registration when `client_id` is not an HTTPS metadata URL.
2. Treat an HTTPS `client_id` with a non-root path as a CIMD candidate.
3. Fetch the document with a short timeout, a bounded JSON response body, no
   redirect following, and DNS/IP checks that reject loopback, private,
   link-local, multicast, and otherwise non-public destinations.
4. Require a valid OAuth client metadata document whose `client_id` exactly
   matches the requested URL and whose redirect URIs satisfy Dofek's existing
   HTTPS/loopback policy.
5. Cache valid metadata for a bounded period, honoring a shorter HTTP
   `Cache-Control: max-age` value and never exceeding 24 hours.

The OAuth discovery document will publish
`client_id_metadata_document_supported: true`; capable clients such as Claude
will skip `/register`. The client metadata is not persisted: its hosted URL is
the canonical client identity and Dofek only needs it while processing OAuth
requests.

## Security Model

CIMD makes the authorization server fetch a URL supplied by an untrusted
client. The resolver must therefore be a narrowly scoped HTTP client rather
than a general-purpose fetch wrapper. It accepts only absolute HTTPS URLs with
a path; resolves DNS before connecting; permits only public IP addresses; uses
the validated address for the connection; sends no credentials; rejects HTTP
redirects; limits response size; and surfaces malformed or unreachable
metadata as an OAuth invalid-client error. These controls address the SSRF
risk specifically called out by the MCP specification. [MCP CIMD security
guidance](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)

The existing consent screen continues to display the client name and the
callback host. Authorization-code, refresh-token, and revocation flows resolve
the same client identity and retain their current exact redirect URI and
resource checks.

## Components

- `packages/server/src/mcp/oauth-client-metadata.ts`: parses URLs, validates
  destination addresses, fetches and validates CIMD JSON, and caches valid
  metadata.
- `packages/server/src/mcp/oauth-client-store.ts`: remains responsible for
  encrypted, persisted DCR clients.
- `packages/server/src/mcp/oauth-client-resolver.ts`: selects stored DCR or
  CIMD metadata without making the OAuth provider depend on either source.
- `packages/server/src/mcp/oauth-provider.ts`: receives the resolver through
  the SDK's registered-client interface.
- `packages/server/src/mcp/oauth-route.ts`: advertises CIMD support through
  OAuth authorization-server metadata.

## Validation

Unit tests cover URL eligibility, public-address filtering, exact `client_id`
matching, redirect URI validation, no-redirect behavior, response-size limits,
cache expiry, and resolver selection. Existing OAuth integration coverage must
continue proving the real-database DCR flow. A CIMD integration test must not
use a local or private metadata host, because accepting one would contradict
the production SSRF policy.

## Non-goals

- No static Claude client ID or shared secret.
- No client metadata persistence or migration.
- No provider-specific behavior; CIMD remains available to any compliant MCP
  client.
- No change to existing Dofek user authentication or MCP scopes.
