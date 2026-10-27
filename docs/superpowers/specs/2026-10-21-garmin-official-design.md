# Official Garmin integration

The user approved replacing Dofek's private Garmin integration after reviewing
the [migration assessment](../../garmin.md). Success means that web and mobile
connect through Garmin OAuth, new activity and existing wellness data arrive
through official notifications, retries retain their input, and existing raw
history remains available. This is the approved implementation direction.

## Scope and architecture

Keep provider ID `garmin` and the independent `garmin-dump` importer. Replace
private credentials, SSO, OAuth1 exchanges, polling, and rate-limit heuristics.
Use the existing server OAuth/PKCE flow and encrypted token repository. Fetch
the official stable account identifier during token exchange; a missing identity
must fail the connection rather than create an unusable notification owner.

Model push-only providers explicitly. OAuth connection remains available;
scheduled and manual polling do not. Targeted notification failures propagate
to the durable job retry instead of falling back to an unrelated window sync.
Portal-managed receiving endpoints must not masquerade as API subscriptions.
Implement verified endpoint authentication after inspecting Garmin API Tools;
never accept an unsigned request solely because it contains a public client ID.

Retain the canonical FIT decoder and existing storage/writers. Persist activity
downloads in existing R2 storage before parsing so parsing retries reuse the
received artifact. Associate retained artifacts with their Dofek user and
provider so account/provider deletion also removes them. A received notification
must be durably queued before its HTTP acknowledgement.

For wellness, preserve current activity, sleep/stage, daily activity, overnight
heart-rate variability, all-day heart-rate, and oxygen coverage. Handle corrected
and provisional summaries as replacements, not additions. Do not invent absent
values or ingest provider-estimated expenditure. Additional product features
(training delivery, route publishing, nutrition, new scores) are outside scope.

Store the canonical account identifier encrypted. If an indexed notification
lookup is needed, derive a domain-separated opaque lookup identifier through
the existing credential identifier primitive rather than storing a second
plaintext identity. Legacy private credentials must require reconnect and must
never reach official refresh or deregistration endpoints.

## Lifecycle and user experience

Both clients use the generic OAuth connect/reconnect flow. Separate the ability
to authorize a source from the ability to request a manual sync; mobile-only
sources keep their existing instructions. Garmin explains that new data arrives
after device synchronization, and existing account-export imports remain the
history path. Permission changes and deregistration invalidate the relevant
authorization and fence pending work.

Official disconnect uses Garmin's documented deregistration operation. Do not
infer successful revocation from undocumented response codes. Preserve current
account-erasure fences and deletion ownership.

Reconnect preserves the existing Garmin registration and replaces OAuth
credentials only after verifying the returned stable account ID matches the
connected account. A different Garmin account requires explicit disconnect
first. Delete the registration only for explicit Disconnect or account erasure.
Failed OAuth attempts, including first connections, preserve remote consent for
retry; failed reconnects also preserve the existing local connection. Use
the [authorized lifecycle contract](https://developerportal.garmin.com/developer-programs/programs-docs).

## External setup and limits

Create only the Health/Activity Starter app needed for current parity, using the
production callback and published privacy/branding URLs. Store required app
credentials in Infisical before considering deployment ready. The approved app
is registered and required production secret key names have been verified; see
the [operator configuration](../../garmin.md#operator-configuration-and-release-checks).
Do not invent legal/company statements or accept unreviewed agreements. Do not
deploy or enable delivery to an unfinished receiver.

Current behavior and tier boundaries come from Garmin's
[public overview](https://developer.garmin.com/gc-developer-program/overview/).
Implementation uses the current authorized
[specifications](https://developerportal.garmin.com/developer-programs/programs-docs),
without copying their confidential documents into this repository. Review
data-use scope against the [program agreement](https://developerportal.garmin.com/developer-programs/4/nda-acceptance?nda=WyIyMzAxIl0%3D)
and [attribution guidelines](https://developer.garmin.com/downloads/brand/Garmin-Developer-API-Brand-Guidelines.pdf).

## Validation

Use test-first unit coverage for OAuth, schemas, mapping, authentication,
callback URL validation, duplicate/revised notifications, and retry behavior.
Execute database integration tests for owner lookup, legacy reconnect state,
wellness updates and deletion. Exercise web/mobile OAuth actions and update
their stories. Run lint, relevant unit/mobile/integration tests and typechecks.
Use a fresh reviewer at each completed implementation boundary and for the
whole change. Real portal authorization and notification/download checks remain
required before calling the production connection verified.
