# Self-Service Developer Clients Design

## Goal

Let any authenticated Dofek user register and operate their own external
integration without an administrator provisioning a client for them. Each
integration user must still explicitly authenticate with Dofek and approve the
requested access before the integration can write data.

## Scope

- Add owner-scoped developer-client registration and management on web and
  mobile.
- Keep the existing external authorization-code, PKCE, grant, nutrition-write,
  rotation, and revocation flow.
- Require a client to use an exactly registered HTTPS redirect URI when it
  starts an authorization transaction.
- Limit self-service clients to the existing `nutrition:write` scope in the
  first release.
- Migrate the Slack Food Bot to a normal registered developer client rather
  than a separately administered integration.

## Non-Goals

- Dynamic Client Registration (RFC 7591) or unauthenticated client creation.
- Public clients without a secret, arbitrary scopes, native custom-scheme
  redirects, webhooks, or a third-party app directory.
- Changing a Dofek user's consent screen, grant lifetime, nutrition storage,
  or the external API's one-time code exchange semantics.

## Architecture

`fitness.external_client` becomes an owner-scoped integration record. It
stores the creating Dofek user, display name, hashed client secret, allowed
scopes, revocation state, and timestamps. A related
`fitness.external_client_redirect_uri` table stores one or more normalized,
complete HTTPS callback URIs per client. The raw client secret is never stored
or returned after creation or rotation.

Authenticated users manage only their own clients through a developer
integrations API. Existing administrators retain a support-only view and may
revoke abusive clients, but normal registration does not require an
administrator. Each create, redirect-URI change, secret rotation, and
revocation appends an audit record with the actor, client, action, and time.

The current external API keeps its client credential format,
`Bearer <clientId>.<clientSecret>`. At `POST /api/external/v1/link/start`,
Dofek authenticates the client, verifies its requested scope, and requires the
requested `redirectUri` to be exactly equal to one of that client's registered
URIs. It then preserves the current S256 PKCE and consent flow. Exact redirect
URI matching avoids the open-redirection and authorization-code leakage risks
described by [RFC 9700 section 4.1](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.1);
PKCE continues to bind the authorization code to the initiating integration as
specified by [RFC 7636](https://www.rfc-editor.org/rfc/rfc7636.html).

## User Experience

### Web and mobile settings

Both clients gain a Developer integrations settings surface with a list of the
signed-in user's clients. A create flow collects:

- a human-readable integration name;
- one or more complete HTTPS callback URIs; and
- `nutrition:write` as the only selectable scope.

After successful creation or secret rotation, the UI presents the client ID
and raw secret exactly once, provides a copy action, and explains that the
secret cannot be recovered. The client detail screen displays redirect URIs,
scope, created and last-rotated times, and active or revoked status. Owners can
add or remove redirect URIs, rotate the secret, or revoke the client. Revoke
requires an explicit confirmation and immediately invalidates its outstanding
grants.

The page links to the existing [external API contract](../../external-api.md)
with a small PKCE example. It does not expose user grants, external subjects,
or raw audit details.

### Authorization and Slack

An integration such as Slack Food Bot registers once through this surface. Its
`/link-dofek` command returns an ephemeral Slack URL button. The user chooses
the button, completes Dofek login and consent in the browser, then returns to
the registered Worker callback. Dofek exchanges the one-time code only when
the integration proves possession of the PKCE verifier and its client
credential; the Worker stores only the resulting user-specific grant.

On a completed callback, Slack sends a direct confirmation to the user and the
browser shows that the account is linked. A failed link start, callback, or
exchange must return a specific safe error to the Slack user and report the
underlying exception to server observability; it must never leave Slack waiting
for an unhandled Worker failure.

## API and Data Model

The authenticated developer API is mounted under `/api/developer/clients`:

| Operation | Behavior |
| --- | --- |
| `GET /` | List the caller's client summaries, never secrets. |
| `POST /` | Create a client and its initial redirect URI set; return ID and secret once. |
| `GET /:clientId` | Read one owner-scoped client and its redirect URIs. |
| `PATCH /:clientId` | Update the display name and full redirect URI set. |
| `POST /:clientId/rotate` | Replace the secret atomically and return it once. |
| `POST /:clientId/revoke` | Revoke the client and all of its active grants. |

Owner list and detail reads include the owner's revoked clients so the revoked
detail screen remains available. Owner mutations (`PATCH`, rotate, and revoke)
return the same `404` for a missing, revoked, or non-owned client, so callers
cannot enumerate other developers' integrations. Validation rejects duplicate
URIs, non-HTTPS URIs, URI fragments, credentials in a URI, and malformed names.
Link-start validates the URI after client authentication and before creating a
link transaction. It returns the existing structured problem envelope; no
redirect occurs on an invalid request.

## Security and Operations

- Rate-limit registration, secret rotation, and external link-start requests.
- Store only SHA-256 client-secret hashes; invalidate all grants immediately on
  client revocation.
- Restrict first-release clients to least-privilege `nutrition:write`. Scope
  expansion is a separate product/security review.
- Preserve the existing fifteen-minute opaque bearer grants and one-time,
  short-lived authorization codes. Bearer tokens stay in Authorization headers
  and never appear in URLs or cookies, following
  [RFC 6750](https://www.rfc-editor.org/rfc/rfc6750.html).
- Capture audit events for create, update, rotate, and revoke. Do not log raw
  secrets, authorization codes, access tokens, Slack IDs, or Dofek user IDs.
- Existing client-provisioning records are assigned an owner during migration;
  records without an accountable owner are admin-revoked rather than exposed to
  self-service management.

## Testing and Validation

- Database integration tests prove owner isolation, audit writes, hashed-secret
  storage, atomically invalidated grants, and redirect-URI constraints.
- Server route tests cover each developer-client operation, safe error
  envelopes, rate-limit behavior, and exact redirect URI matching at link
  start.
- Web and mobile tests cover listing, one-time secret display/copy, redirect
  URI editing, rotation, revocation confirmation, loading states, and surfaced
  server errors.
- External API integration tests cover an owner-created client completing the
  full PKCE link, consent, exchange, and nutrition-write flow; a non-registered
  redirect URI must be rejected before authorization.
- Slack Food Bot tests cover an ephemeral URL button, callback completion DM,
  and an actionable error response when Dofek rejects link creation.

## Rollout

1. Ship the Dofek schema, server API, and web/mobile developer settings UI.
2. Create a self-service client for Slack Food Bot and place its credential in
   the Worker secret store.
3. Deploy the Worker with the Block Kit button and callback confirmation.
4. Exercise the complete production link flow with a test Dofek account before
   announcing the integration.

The external API contract is updated alongside implementation to state that
all clients—including Slack—are developer-owned clients with registered,
exact HTTPS redirect URIs.
