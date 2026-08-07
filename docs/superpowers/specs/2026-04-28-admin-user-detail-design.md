# Admin User Detail Design

## Context

The admin page currently lists users in a table and shows user details in an inline expanded panel. Admins can toggle `is_admin` from the table, but they cannot click through to a dedicated user page or manage related account flags and local billing access in one place.

Billing access is already stored locally in `fitness.user_billing`. Stripe remains the source of truth for real subscription changes, while Dofek uses local billing state to derive access. Provider guide dismissal is stored in `fitness.user_settings` under the `provider_guide_dismissed` key.

## Goals

- Add a dedicated admin user detail page.
- Link from the admin users table to that detail page.
- Let admins view and edit local account flags for a user.
- Let admins view local billing state and grant or revoke free access.
- Provide Stripe Dashboard links for editing the customer or subscription in Stripe.
- Keep Stripe mutations out of this admin page.

## Non-Goals

- Creating, canceling, or modifying Stripe subscriptions from Dofek.
- Adding a generic arbitrary user settings editor.
- Adding new billing concepts beyond the existing local paid grant model.
- Changing subscription enforcement or access-window logic.
- Changing mobile behavior.

## User Experience

The admin Users tab will make each user clickable. Selecting a user opens `/admin/users/$userId`.

The detail page will use the existing admin visual style and show:

- user identity: name, email, short ID, created and updated timestamps;
- account flags: admin status and provider guide dismissal;
- billing state: local paid grant, derived access state, Stripe customer ID, Stripe subscription ID, Stripe subscription status, and current period end;
- Stripe links: customer and subscription links when local Stripe IDs exist;
- existing supporting details: auth accounts, data providers, and recent sessions.

Flag controls should be direct toggles. Billing controls should make the local-only behavior obvious:

- enabling free access stores a local paid grant reason of `admin_grant`;
- disabling free access clears the local paid grant reason;
- Stripe subscription fields are display-only in Dofek and edited through Stripe Dashboard links.

## Server Design

Extend the existing `admin` tRPC router rather than adding a separate admin billing router.

`admin.userDetail` should return a full detail payload:

- `profile`: `id`, `name`, `email`, `birth_date`, `is_admin`, `created_at`, `updated_at`;
- `flags`: `providerGuideDismissed`;
- `billing`: `stripe_customer_id`, `stripe_subscription_id`, `stripe_subscription_status`, `stripe_current_period_end`, `paid_grant_reason`, `created_at`, `updated_at`;
- `access`: result of the existing `resolveAccessWindow()` helper;
- `stripeLinks`: dashboard URLs for existing customer and subscription IDs;
- `accounts`, `providers`, and `sessions`, matching the current detail data.

Add admin mutations:

- `admin.setAdmin({ userId, isAdmin })`;
- `admin.setProviderGuideDismissed({ userId, dismissed })`;
- `admin.setPaidGrant({ userId, enabled })`.

`setProviderGuideDismissed` should write the existing `provider_guide_dismissed` setting for the target user. `setPaidGrant` should upsert or clear `fitness.user_billing.paid_grant_reason` without touching Stripe fields.

All admin queries and mutations remain behind `adminProcedure`.

## Data Model

No schema migration is required.

Existing storage is sufficient:

- `fitness.user_profile.is_admin`;
- `fitness.user_settings` with key `provider_guide_dismissed`;
- `fitness.user_billing.paid_grant_reason`;
- `fitness.user_billing` Stripe ID and status fields.

The implementation should not add a duplicate `has_free_access` boolean because access is already derived from `paid_grant_reason` and Stripe status.

## Stripe Links

The admin detail page should generate Stripe Dashboard links from local IDs:

- customer: `https://dashboard.stripe.com/customers/{stripeCustomerId}`;
- subscription: `https://dashboard.stripe.com/subscriptions/{stripeSubscriptionId}`.

The links are only navigation aids. The Dofek mutation layer must not call Stripe for subscription management in this feature.

## Web Routing

Add TanStack Router files for the user detail route:

- `packages/web/src/routes/admin/users/$userId.tsx`;
- lazy route file if needed to match existing route conventions.

The new page can live in `packages/web/src/pages/AdminUserDetailPage.tsx` to keep `AdminPage.tsx` from growing further.

After adding route files, regenerate or update the TanStack route tree using the repo's existing workflow.

## Testing

Use TDD for implementation.

Server tests:

- `admin.userDetail` returns profile, flags, billing, derived access, Stripe links, accounts, providers, and sessions;
- `setProviderGuideDismissed` writes the target user's setting;
- `setPaidGrant` stores `admin_grant` when enabled;
- `setPaidGrant` clears the local paid grant without clearing Stripe IDs or status;
- `setAdmin` behavior remains covered.

Web tests:

- users table exposes a click-through link to `/admin/users/$userId`;
- user detail page renders profile, flags, billing state, and Stripe links;
- toggling local flags calls the correct admin mutations and refreshes detail data;
- non-admin users still see the existing no-access state.

## Rollout

1. Add failing admin router tests for the detail payload and local mutations.
2. Implement the minimum server changes in the existing admin router.
3. Add failing web tests for click-through navigation and detail controls.
4. Implement the user detail route and page.
5. Regenerate the route tree if required.
6. Run focused tests, then the repo-required checks before pushing.

## Open Questions

None. The design assumes Dofek controls only local billing state and uses Stripe Dashboard links for real subscription edits.
