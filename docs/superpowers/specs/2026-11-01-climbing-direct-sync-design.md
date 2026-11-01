# Vertical-Life and Crimpd direct sync

## Intent and agreed approach

The user approved direct server sync for both providers, with renewable
authentication verified before implementation and existing import/storage paths
reused where they preserve source data. Connect an account once on either web
or mobile, then use Dofek's existing scheduled and manual provider syncs.

Alternatives considered were continued manual imports and browser-assisted
collection. Manual imports already exist but do not meet the automatic-sync
request. Browser-assisted collection would introduce a new runtime dependency
and would not establish renewable server authentication. Direct server sync is
the selected approach; it must not silently fall back to those alternatives.

## Evidence and prerequisites

The [October 31 investigation](../../climbing-logbook-api-research.md) verified
Crimpd browser login, refresh, logbook reads, and ZIP export. Its deployed
[web client](https://my.crimpd.com/main.3bcc34bf74e9df68.js) uses
`POST /auth/jwt`, `POST /auth/refresh`, and
`GET /analytics/export?format=zip`. Independently verify initial login,
rotated-token persistence, subsequent authenticated reads, and populated raw
workout/set semantics before claiming the connector works. Crimpd documents
its export's scope and fields in the [export reference](https://crimpd.com/docs/data-export/).

The same investigation verified authenticated 8a.nu ascent pages and export,
including empty indoor categories and populated public outdoor pages. The
vendor [announces shared Vertical-Life/8a.nu logbooks](https://www.8a.nu/news/find-your-logbook-in-the-vertical-life-app).
Independent Node export requests still returned Cloudflare HTTP 403 on November
1; browser success is not evidence of server access. The
[OIDC discovery document](https://vlatka.vertical-life.info/auth/realms/Vertical-Life/.well-known/openid-configuration)
responded with authorization-code, PKCE and refresh support, but this does not
prove that Dofek can register a client or reuse an existing client's grants.

Authentication verification is a prerequisite, not permission to ship a
placeholder. Record exact responses without secrets. If direct access cannot
be established after reasonable investigation, report the precise external
prerequisite and ask before changing strategy. Crimpd work may continue
independently of Vertical-Life access.

## Connection and credential lifecycle

Extend the existing `crimpd` and `eight-a` provider identities into real sync
providers. Reuse per-user encrypted token storage, the provider HTTP boundary,
existing credential/OAuth connection controls, worker registration, scheduling,
and processing-status reporting. User passwords must not become deployment
environment variables or appear in logs, fixtures, or committed files.

Use Crimpd's observed username/password exchange and refresh endpoint.
Vertical-Life's exact sign-in mechanism remains an investigation result: select
only a proven server-usable grant and verify its refresh lifecycle. Do not
invent redirect registrations, use arbitrary browser cookies as permanent
credentials, or claim realm-wide grant support proves client-specific access.

Persist rotating refresh credentials before further remote work. Authentication
failures must produce actionable reconnect messages. Verify disconnection,
reconnection ownership, and account-erasure behavior through the repository's
existing lifecycle contracts; never claim upstream revocation without evidence.

## Import and storage behavior

Keep existing uploads available alongside account connection on both platforms.
Both paths write through existing canonical activity/climbing persistence, with
raw source facts and original payloads retained. No parallel tables, fabricated
activity durations, provider calorie expenditure, or client-side metrics.

For Crimpd, prefer authenticated download of the documented ZIP and reuse its
archive/parser/persistence path when the populated export confirms completeness
for the supported workout facts. Preserve native workout/set identities. Any
extension to JSON ingestion must be supported by observed missing raw facts,
not an assumed richer payload.

For Vertical-Life, use verified JSON ascent pagination when server access is
established, preserving native ascent IDs, source category and explicit project,
repeat and duplicate flags. Validate the four observed categories and fetch
until an empty page, with the completeness filters described in the
[research notes](../../climbing-logbook-api-research.md#vertical-life-browser-session-access-verified).
Do not treat a per-page `totalItems` field as the whole-history total.

Existing Vertical-Life CSV entries use content/occurrence identities because
the [export](https://www.8a.nu/faq) lacks native ascent IDs. Before enabling sync,
inspect existing data and establish whether CSV rows can be matched uniquely to
native records using verified fields. Migrate only proven one-to-one identities,
preserving attachments and raw provenance. Ambiguous matches must not be merged
or silently duplicated. If no sound transition can be established, bring that
concrete decision back to the user before shipping the connector.

Apply that identity resolution to every subsequent CSV upload as well as the
initial transition and native-ID sync. A uniquely matched upload updates the
same canonical record; a genuinely new source occurrence is imported once.
Reject ambiguous cross-path matches with an actionable message, without
partial writes, rather than creating duplicate records or guessing a merge.
Use the same resolver for both ingestion paths and test upload-before-sync,
sync-before-upload, repeated uploads, edited rows and ambiguous duplicates.

Remote absence may be reconciled only after a proven complete authoritative
fetch, through the existing snapshot/activity helpers. Partial fetches,
authentication failures and ordinary uploads never establish remote deletion.

## Client behavior and validation

Web and mobile expose equivalent Connect, reconnect, manual sync, processing
status and upload actions through the existing provider flow. Keep connection
instructions concise and display actionable server error messages.

Use test-first implementation. Unit tests cover wire parsing, refresh and error
behavior; database integration tests with network-level mocks cover identity,
repeated imports, attachments, user isolation, authoritative absence and failed-fetch
safety. Both client suites cover connection plus upload availability. Verify
real authentication, renewal and reads separately from mocked tests, without
mutating upstream logbooks or inventing sample owner records.

Run appropriate lint, typechecks, unit/mobile and database checks; independently
review changes, resolve findings, update current provider documentation, commit
and push automatically. Do not switch branches or deploy production as part of
this work. No new dependencies or schema are proposed; either requires current
evidence and the repository's normal review rules if investigation proves it
necessary.

## Builder discretion and completion

The implementer chooses provider-local module boundaries, schemas for observed
responses, focused tests and existing helper reuse. The completion claim must
distinguish implemented/tested behavior from live verification and any external
access blocker. Both connectors remain in scope; success for one does not imply
success for the other.
