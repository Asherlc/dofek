# App Store In-App Purchase Design

## Context

Dofek currently uses a Stripe subscription to grant full access to health-data
history and analytics. The iOS Settings screen opens Stripe Checkout, which is
not appropriate for unlocking digital app functionality in the iOS app. Dofek
will add an Apple auto-renewable subscription while keeping Stripe as the
web-only purchase rail.

## Goals

- Offer a single $4.99/month auto-renewable iOS subscription.
- Configure the App Store product ID as `com.dofek.premium.monthly` in the
  `Dofek Premium` subscription group.
- Replace iOS Stripe purchase and management actions with StoreKit 2 purchase,
  restore, and Apple subscription-management actions.
- Verify Apple-signed transactions on the server before granting access.
- Keep server-side access windows authoritative for both web and mobile.
- Grant full access to a user with either a verified active App Store
  subscription, an active Stripe web subscription, or an internal paid grant.
- Reconcile lifecycle changes through App Store Server Notifications V2.

## Non-Goals

- Multiple tiers, annual pricing, free trials, introductory offers, or offer
  codes.
- Moving web purchases from Stripe to Apple.
- Client-side entitlement decisions.
- Supporting external-purchase links in the iOS app.

## Architecture

### Billing boundary

StoreKit 2 is the only iOS billing interface. A narrow native module owns
product lookup, purchase, current-entitlement restoration, transaction-update
observation, and opening Apple subscription management. It never decides
whether the user may read health data; it submits Apple-signed transaction JWS
data to Dofek's authenticated server.

The server owns the canonical entitlement. It uses Apple's maintained
`@apple/app-store-server-library` to validate the JWS chain and decoded
transaction payload. It verifies the expected bundle ID, environment, product
ID, app-account token, expiration, and revocation before persisting the App
Store subscription state. Apple's App Store Server API recommends this signed
transaction path rather than the deprecated `verifyReceipt` endpoint.

References: [App Store Server API](https://developer.apple.com/documentation/appstoreserverapi),
[validating receipts](https://developer.apple.com/documentation/storekit/validating-receipts-with-the-app-store),
and [Apple's Node library](https://github.com/apple/app-store-server-library-node).

### Data flow

```text
iOS Settings → StoreKit 2 purchase / restore → signed transaction JWS
                                                ↓
                                    authenticated server verification
                                                ↓
                               fitness.user_billing App Store fields
                                                ↓
                     existing server entitlement and API access-window gate

Apple Server Notifications V2 → public verified webhook → same billing record
```

On every signed transaction supplied by the client, the server ensures that it
belongs to the authenticated Dofek account. The native purchase request sends a
stable opaque UUID `appAccountToken`; the server creates that random token once
per Dofek user and never reuses the user-profile ID as an Apple token.

The native module also consumes StoreKit's current entitlements and transaction
updates so a purchase, restore, or cross-device update is promptly submitted to
the server. StoreKit documents `Transaction.currentEntitlements` and
`Transaction.updates` as the current entitlement and change streams.
[StoreKit entitlement documentation](https://developer.apple.com/documentation/storekit/transaction/currententitlements)

### Schema and entitlement model

Extend `fitness.user_billing`, rather than creating a competing entitlement
table, with the App Store-specific state needed to verify and reconcile one
subscription:

- `app_store_account_token uuid unique`
- `app_store_original_transaction_id text unique`
- `app_store_transaction_id text unique`
- `app_store_product_id text`
- `app_store_subscription_status text`
- `app_store_expires_at timestamptz`
- `app_store_revocation_at timestamptz`
- `app_store_environment text`

`fitness.app_store_notification` is the sole replay-protection ledger for
Apple notification UUIDs and signed dates; do not duplicate that information
on the user billing row.

The server treats an App Store entitlement as active only when the product ID is
the configured product, the subscription state is active or in billing grace,
the expiration is in the future, and the transaction has not been revoked.
The existing resolver returns full access when this condition, Stripe's existing
active/trialing condition, or an internal grant applies. The resolver remains
the one canonical access decision.

### Server APIs and notifications

- `billing.status` returns server-derived access state and whether the current
  platform can open StoreKit subscription management. It never exposes payment
  credentials or signed payloads.
- `billing.appStorePurchaseContext` returns the authenticated user's opaque
  UUID `appAccountToken` and the expected product ID.
- `billing.verifyAppStoreTransaction` accepts one transaction JWS, verifies it,
  applies an idempotent state update, and returns the resulting server-derived
  access state.
- `POST /api/webhooks/app-store` accepts App Store Server Notifications V2. It
  verifies the signed notification and its signed transaction/renewal payloads,
  deduplicates by notification UUID, and applies the same idempotent state
  transition as client verification.

The App Store Server Notification URL is configured in App Store Connect. The
server fails loudly when a required Apple billing key, certificate bundle ID, or
product configuration is absent.

### iOS experience

An unpaid user sees “Subscribe — $4.99/month” in Settings. Selecting it loads
the configured StoreKit product and starts Apple's system purchase sheet. On
success, the app submits the verified transaction to the server, finishes the
StoreKit transaction only after the server accepts it, then refreshes billing
status and the affected queries.

The Settings screen offers Restore Purchases, which reads current StoreKit
entitlements and sends each verified entitlement to the server. A subscriber
sees Manage Subscription, which opens Apple's subscription-management surface.
The iOS app removes all Stripe Checkout and Stripe billing-portal actions;
those continue only on the web Settings page.

### Configuration and operations

Create the following in App Store Connect before release:

1. `Dofek Premium` subscription group.
2. `com.dofek.premium.monthly` auto-renewable subscription at $4.99 USD/month,
   with required localized metadata and review attachment.
3. An In-App Purchase server API key and notification URL.

Add these server configuration values to Infisical for every environment that
receives Apple transaction traffic before deploying code that reads them:

- `APP_STORE_ISSUER_ID`
- `APP_STORE_KEY_ID`
- `APP_STORE_PRIVATE_KEY`
- `APP_STORE_APP_ID`
- `APP_STORE_BUNDLE_ID`
- `APP_STORE_SUBSCRIPTION_PRODUCT_ID`
- Apple root certificate bundle required by the verifier

The deployment runbook will document sandbox versus production configuration,
notification verification, and how to send an Apple test notification.

## Error handling

- An unverified StoreKit transaction is never sent as a successful purchase and
  is reported to Sentry with no transaction payload.
- A server verification failure returns a specific error to the app; the app
  displays that message and reports the exception to Sentry.
- A transaction for another account, bundle, product, or environment is
  rejected before any billing write.
- Duplicate client submissions and duplicate notifications are idempotent.
- A notification that lacks a verified transaction preserves the prior state
  and emits a monitored failure; it never grants access.

## Testing and release validation

Follow TDD for every production behavior.

- Unit-test App Store transaction validation and entitlement transitions,
  including wrong product, wrong account token, expiry, revocation, and
  duplicate delivery.
- Write database-backed integration tests for the billing row upsert and
  notification idempotency.
- Unit-test the mobile billing service with a StoreKit adapter fake: product
  loading, success, cancellation, restore, and server rejection.
- Add Settings screen tests proving iOS calls the StoreKit service rather than
  opening Stripe, while web continues to use Stripe.
- Run a physical-device StoreKit sandbox purchase, restore, renewal/update, and
  Apple test-notification audit before submission. App Store server APIs support
  the sandbox environment for this validation.
  [Apple sandbox documentation](https://developer.apple.com/documentation/appstoreserverapi)

## Rollout

1. Create and validate the App Store Connect subscription and Apple server key.
2. Add Infisical configuration and verified server notification endpoint.
3. Deploy the server verification and notification path before the iOS client.
4. Release the iOS StoreKit client with Stripe purchase/portal actions removed.
5. Complete StoreKit sandbox and TestFlight validation, then resubmit with an
   updated business-model explanation.
