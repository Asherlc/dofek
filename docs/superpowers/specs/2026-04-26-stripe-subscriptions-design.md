# Stripe Subscriptions Design

## Context

Dofek will add one paid subscription plan using Stripe. Users who do not have paid access can still sync and import all historical health data, but every read endpoint must limit returned data to the seven calendar days starting on the user's signup date. Existing accounts should default to paid access.

The implementation must keep access control on the server. Web and mobile clients render server responses and subscription actions; they do not compute entitlement or derive wider data windows.

## Goals

- Add Stripe subscriptions for one paid plan.
- Allow unpaid users to read only signup day through signup day plus six calendar days.
- Apply the unpaid read gate to all read endpoints, including charts, reports, details, streams, exports, and insights.
- Keep ingestion unrestricted for every user.
- Grant existing accounts paid access without requiring immediate Stripe subscription creation.
- Share the same subscription status and paywall behavior across web and mobile.

## Non-Goals

- Multiple subscription tiers.
- Per-feature gates.
- Client-side-only paywalls.
- A custom payment form.
- Limiting sync/import based on subscription status.
- Apple in-app purchases.

## Architecture

Stripe owns billing and payment collection. The Dofek server owns entitlement and data access decisions.

The server stores local billing state for each user and updates it from verified Stripe webhooks. Web and mobile call server APIs for subscription status, Stripe Checkout session creation, Stripe Customer Portal session creation, and all health data reads. This keeps access decisions consistent across platforms and avoids making every read request depend on a live Stripe API call.

Existing accounts receive an internal paid grant so they keep full access even before they have a Stripe customer or subscription. New accounts without an access-granting Stripe subscription remain unpaid after signup and can read only their signup-week data.

## Data Model

Add one billing table keyed by user:

```sql
fitness.user_billing
```

Fields:

- `user_id`
- `stripe_customer_id`
- `stripe_subscription_id`
- `stripe_subscription_status`
- `stripe_current_period_end`
- `paid_grant_reason`
- `created_at`
- `updated_at`

Effective paid access is derived, not stored as a duplicate boolean:

- paid when `paid_grant_reason` is present;
- paid when Stripe subscription status grants access, initially `active` or `trialing`;
- unpaid otherwise.

The migration should backfill existing users with `paid_grant_reason = 'existing_account'`.

## Configuration

The server needs Stripe configuration and should fail fast when a billing path is invoked without required config:

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_ID`
- canonical app return URL configuration if no existing public URL setting can be reused

New environment variables must be added to Infisical for the relevant environments before deployment.

Stripe live and sandbox state should stay in separate deployments rather than being toggled inside production:

- production uses the `prod` Infisical environment, the production database, and Stripe live keys;
- staging uses the `staging` Infisical environment, the staging database, and Stripe sandbox keys.

This avoids storing sandbox customers, subscriptions, or webhook events in the production database.

## API

Add a billing router:

- `billing.status`: returns whether the user has full access, the free-window dates, subscription status, and display-ready status details for clients.
- `billing.createCheckoutSession`: creates a Stripe Checkout subscription session for the configured Price ID.
- `billing.createPortalSession`: creates a Stripe Customer Portal session for the user's Stripe customer.

Add an Express webhook route:

- `POST /webhooks/stripe`: verifies Stripe signatures and updates local billing state for subscription and checkout events.

Stripe Checkout and the Customer Portal remain Stripe-hosted. The app does not collect card details directly.

## Read Gating

Add a shared server helper that resolves the current user's access window:

- Paid users: no billing clamp beyond each endpoint's own requested or default window.
- Unpaid users: clamp reads to `[signup_date, signup_date + 7 days)`.

Each repository or router still applies the window to its own data model because endpoints use different date fields and query shapes:

- date-based endpoints clamp `date` ranges;
- timestamp-based endpoints clamp `started_at`, `recorded_at`, or equivalent fields;
- ID-based detail endpoints require the parent record to fall inside the allowed window before returning details;
- child endpoints such as activity streams require the parent activity to be visible;
- reports, predictions, correlations, trends, insights, and exports compute from only visible data for unpaid users.

If an unpaid user does not have enough signup-week data for an analysis endpoint, the endpoint should return its existing empty or insufficient-data behavior rather than using hidden full-history data.

## Web UI

Add a billing section to Settings:

- current access state;
- free-window dates for unpaid users;
- Subscribe action for unpaid users;
- Manage billing action for paid Stripe customers.

Data pages can render a concise server-derived notice when access is limited. They should not compute entitlement or fetch wider data in the client.

## Mobile UI

Add the same subscription status and Subscribe/Manage actions to Settings. Mobile opens Stripe-hosted Checkout or Portal via the existing external browser flow. Mobile data screens render server responses and any server-provided limited-access notice without computing entitlement locally.

## Testing

Use TDD for implementation.

Required coverage:

- entitlement and access-window unit tests;
- billing status router tests;
- Checkout session creation tests with mocked Stripe APIs;
- Customer Portal session creation tests with mocked Stripe APIs;
- Stripe webhook signature and event handling tests;
- read-gating tests for at least one date-window endpoint, one ID detail endpoint, one child/detail endpoint, and one historical analysis or report endpoint;
- web and mobile Settings tests for status rendering and Subscribe/Manage actions.

Integration tests that touch database behavior must run with Docker dependencies started first.

## Rollout

1. Add the schema and migration.
2. Backfill existing accounts with an internal paid grant.
3. Add required Stripe secrets/config to Infisical.
4. Configure the Stripe webhook endpoint and Customer Portal in Stripe.
5. Implement billing APIs and webhook handling.
6. Apply server-side read gating endpoint by endpoint with tests.
7. Add web and mobile Settings UI.
8. Validate locally with mocked tests.
9. Validate the full checkout and webhook flow in staging with Stripe sandbox before promoting the same image to production.

## References

- Stripe subscription webhooks: https://docs.stripe.com/billing/subscriptions/webhooks
- Stripe Checkout subscriptions: https://docs.stripe.com/payments/subscriptions
- Stripe Customer Portal: https://docs.stripe.com/billing/subscriptions/integrating-customer-portal
