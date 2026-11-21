# Intervals.icu provider setup

The provider ID is `intervals.icu`.

## Required environment variables

- `INTERVALS_ICU_CLIENT_ID`
- `INTERVALS_ICU_CLIENT_SECRET`

Set both in Infisical in each environment that offers the provider. Dofek shows the connection option once both credentials are configured.

## Vendor approval

Apply for an OAuth client and include Dofek’s redirect URI, `/callback` on the Dofek web host. Require S256 PKCE on the client. Intervals.icu must approve the app before users can connect. [OAuth application guide](https://forum.intervals.icu/t/intervals-icu-oauth-support/2759)

## Scopes and tokens

Dofek requests `ACTIVITY:READ`, `WELLNESS:READ`, and `CALENDAR:READ` and rejects a connection that
does not grant all three. Tokens have no documented expiry or refresh credential, so Dofek stores
the access token with a one-year placeholder expiry and `reconnectStrategy: "replace"`.

Intervals.icu applies the athlete’s latest grant scopes to all tokens for the app. If an athlete reduces the scopes, they must grant all three again before all data can sync. [Intervals.icu scope behavior](https://forum.intervals.icu/t/intervals-icu-oauth-support/2759/24)

## Revocation

`DELETE /api/v1/disconnect-app` with the bearer token. Only HTTP 200 (revoked) and 401 (invalid bearer token, per the official
[API docs](https://intervals.icu/api/v1/docs)) are terminal; anything else is retried. Token and revoke requests do not follow redirects.

## Retained athlete binding

The athlete ID is stored as a keyed digest on `fitness.provider_data_generation`
(`source_account_digest`, `source_account_generation`). It survives disconnect and rejects a
different athlete while data is retained or deletion is pending. Completing the matching deletion
generation clears it; a binding re-touched for a newer generation is preserved. Metadata-only
bindings keep "Delete provider data" available.
