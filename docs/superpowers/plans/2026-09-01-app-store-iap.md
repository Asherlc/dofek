# App Store In-App Purchase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a $4.99/month StoreKit 2 subscription that grants Dofek server-side full access on iOS and remains valid on the web.

**Architecture:** iOS owns StoreKit product presentation and sends Apple-signed transaction JWS data to the authenticated tRPC server. The server verifies JWS with Apple's official App Store Server Library, persists the subscription state in `fitness.user_billing`, and updates that same state from App Store Server Notifications V2. Existing `resolveAccessWindow` remains the only access decision and recognizes Stripe, App Store, and internal-grant sources.

**Tech Stack:** TypeScript, Expo Modules API, Swift StoreKit 2, Express, tRPC 11, Drizzle, PostgreSQL, Vitest, XCTest, `@apple/app-store-server-library@3.1.0`.

**Spec:** `docs/superpowers/specs/2026-09-01-app-store-iap-design.md`

## Global Constraints

- Configure exactly one `Dofek Premium` auto-renewable subscription: `com.dofek.premium.monthly`, priced at $4.99 USD/month.
- Keep Stripe as the web-only checkout and management rail; remove Stripe purchase and portal actions from iOS.
- Verify transaction JWS on the server; do not grant access from client-side StoreKit state.
- Store only one canonical entitlement decision in `resolveAccessWindow`; either payment rail may satisfy it.
- Use the official Apple server library instead of deprecated `verifyReceipt` or a custom JWS parser.
- New secrets must exist in Infisical before deployment; no missing-config fallback is permitted.
- Every catch reports unexpected errors to Sentry; users see the actionable server error message.
- Follow TDD: write a focused failing test, run it, implement the minimum production code, then re-run it before proceeding.
- Do not place tests or non-route helpers under `packages/mobile/app/`.

---

## File Structure

- `drizzle/0103_app_store_billing.sql` adds the App Store columns and the sole notification-idempotency table.
- `src/db/schema/account.ts` models the App Store billing columns and notification table.
- `packages/server/src/billing/app-store-config.ts` parses required Apple configuration once.
- `packages/server/src/billing/app-store-verifier.ts` wraps Apple's verifier behind a focused interface.
- `packages/server/src/billing/app-store-subscription.ts` translates verified Apple payloads into a Dofek subscription state.
- `packages/server/src/repositories/billing-repository.ts` owns token creation, App Store lookup, and idempotent state persistence.
- `packages/server/src/routes/app-store-webhook.ts` verifies and processes Notifications V2 before JSON middleware.
- `packages/mobile/modules/app-store-billing/` is the Expo/Swift StoreKit bridge.
- `packages/mobile/lib/app-store-billing.ts` coordinates native StoreKit with the tRPC billing API.
- `packages/mobile/app/settings.tsx` renders StoreKit purchase, restore, and management actions on iOS only.

## Task 1: Model verified App Store subscription state

**Files:**
- Modify: `src/db/schema/account.ts:329-390`
- Create: `drizzle/0103_app_store_billing.sql`
- Modify: `packages/server/src/billing/entitlement.ts`
- Modify: `packages/server/src/billing/entitlement.test.ts`

**Consumes:** Existing `fitness.user_billing`, Stripe fields, and `resolveAccessWindow`.

**Produces:** `AppStoreSubscriptionState` and an access resolver that recognizes an unexpired, non-revoked Apple subscription for `com.dofek.premium.monthly`.

- [ ] **Step 1: Write failing entitlement tests**

```ts
it("grants full access for an active verified App Store subscription", () => {
  expect(resolveAccessWindow({
    userCreatedAt: "2026-09-01T00:00:00.000Z",
    timezone: "UTC",
    paidGrantReason: null,
    stripeSubscriptionStatus: null,
    appStoreSubscription: {
      productId: "com.dofek.premium.monthly",
      status: "active",
      expiresAt: "2026-10-01T00:00:00.000Z",
      revokedAt: null,
    },
    now: new Date("2026-09-15T00:00:00.000Z"),
  })).toEqual({ kind: "full", paid: true, reason: "app_store_subscription" });
});

it("does not grant App Store access after expiry or revocation", () => {
  expect(resolveAccessWindow({
    userCreatedAt: "2026-09-01T00:00:00.000Z", timezone: "UTC", paidGrantReason: null,
    stripeSubscriptionStatus: null,
    appStoreSubscription: { productId: "com.dofek.premium.monthly", status: "expired", expiresAt: "2026-09-10T00:00:00.000Z", revokedAt: null },
    now: new Date("2026-09-15T00:00:00.000Z"),
  }).kind).toBe("limited");
  expect(resolveAccessWindow({
    userCreatedAt: "2026-09-01T00:00:00.000Z", timezone: "UTC", paidGrantReason: null,
    stripeSubscriptionStatus: null,
    appStoreSubscription: { productId: "com.dofek.premium.monthly", status: "active", expiresAt: "2026-10-01T00:00:00.000Z", revokedAt: "2026-09-14T00:00:00.000Z" },
    now: new Date("2026-09-15T00:00:00.000Z"),
  }).kind).toBe("limited");
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm vitest run --project unit packages/server/src/billing/entitlement.test.ts`

Expected: TypeScript/test failure because `appStoreSubscription` and the new access reason do not exist.

- [ ] **Step 3: Add the schema migration and minimum resolver input**

Add nullable App Store fields to `fitness.user_billing`: `app_store_account_token uuid unique`, transaction IDs, product ID, status, expiration, revocation, and environment. Create `fitness.app_store_notification` with `notification_uuid` primary key and `signed_date` as the sole notification-idempotency ledger. Extend `resolveAccessWindow` to return `app_store_subscription` only for the configured product, an active status with a future transaction expiry or a grace-period status with a future renewal grace-period expiry, and null revocation.

```ts
export type AccessWindow =
  | { kind: "full"; paid: true; reason: "paid_grant" | "stripe_subscription" | "app_store_subscription" }
  | { kind: "limited"; paid: false; reason: "free_signup_week"; startDate: string; endDateExclusive: string };
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm vitest run --project unit packages/server/src/billing/entitlement.test.ts`

Expected: PASS, including all existing Stripe and free-window cases.

- [ ] **Step 5: Verify migration policy and commit**

Run: `pnpm lint:migrations && pnpm typecheck`

Commit:

```bash
git add src/db/schema/account.ts drizzle/0103_app_store_billing.sql packages/server/src/billing/entitlement.ts packages/server/src/billing/entitlement.test.ts
git commit -m "Add App Store billing state"
```

## Task 2: Verify Apple-signed transactions and persist them idempotently

**Files:**
- Create: `packages/server/src/billing/app-store-config.ts`
- Create: `packages/server/src/billing/app-store-verifier.ts`
- Create: `packages/server/src/billing/app-store-subscription.ts`
- Create: `packages/server/src/billing/app-store-verifier.test.ts`
- Modify: `packages/server/src/repositories/billing-repository.ts`
- Modify: `packages/server/src/repositories/billing-repository.test.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Consumes:** Task 1 schema and Apple `SignedDataVerifier` from `@apple/app-store-server-library@3.1.0`.

**Produces:** `verifyAppStoreTransaction(jws, expectedAccountToken)` and `BillingRepository.applyAppStoreSubscription(input)`.

- [ ] **Step 1: Write failing verifier tests**

```ts
it("accepts a verified transaction only for the configured product and account token", async () => {
  const result = await verifier.verifyTransaction("signed-jws", "a0000000-0000-4000-8000-000000000001");
  expect(result.originalTransactionId).toBe("100000000000001");
});

it("rejects a verified transaction for a different app account token", async () => {
  await expect(verifier.verifyTransaction("other-account-jws", EXPECTED_TOKEN)).rejects.toMatchObject({
    code: "PRECONDITION_FAILED",
  });
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm vitest run --project unit packages/server/src/billing/app-store-verifier.test.ts`

Expected: FAIL because the verifier module does not exist.

- [ ] **Step 3: Install the exact official library and implement verification**

Add `@apple/app-store-server-library@3.1.0` to `packages/server/package.json`. `getAppStoreBillingConfig()` must require `APP_STORE_ISSUER_ID`, `APP_STORE_KEY_ID`, `APP_STORE_PRIVATE_KEY`, `APP_STORE_APP_ID`, `APP_STORE_BUNDLE_ID`, `APP_STORE_SUBSCRIPTION_PRODUCT_ID`, and `APP_STORE_ROOT_CERTIFICATES_PEM`; it must throw a message naming the missing key. Build `SignedDataVerifier` with those root certificates, expected bundle ID, app Apple ID, and decoded transaction environment. Reject mismatched product ID, absent/mismatched app-account token, empty original transaction ID, malformed expiry, or an unverified JWS.

Normalize only these persistence fields:

```ts
interface AppStoreSubscriptionUpdate {
  accountToken: string;
  originalTransactionId: string;
  transactionId: string;
  productId: "com.dofek.premium.monthly";
  status: "active" | "grace_period" | "expired" | "revoked";
  expiresAt: Date | null;
  revokedAt: Date | null;
  environment: "Sandbox" | "Production";
}
```

`applyAppStoreSubscription` must upsert the user’s row only when its token matches, retain the latest transaction ID, and never let an older transaction replace a newer expiration.

- [ ] **Step 4: Write and run the database integration test**

Create `packages/server/src/repositories/billing-repository.integration.test.ts` that creates two users, assigns one account token, applies a current update, replays it, then attempts a token belonging to the second user. Assert the first replay is harmless and the cross-user update changes no row.

Run: `pnpm test:integration -- packages/server/src/repositories/billing-repository.integration.test.ts`

Expected before implementation: FAIL because `applyAppStoreSubscription` is absent; after implementation: PASS.

- [ ] **Step 5: Run unit tests and commit**

Run: `pnpm vitest run --project unit packages/server/src/billing/app-store-verifier.test.ts packages/server/src/repositories/billing-repository.test.ts`

Commit:

```bash
git add package.json pnpm-lock.yaml packages/server/src/billing packages/server/src/repositories/billing-repository.ts packages/server/src/repositories/billing-repository.test.ts packages/server/src/repositories/billing-repository.integration.test.ts
git commit -m "Verify App Store subscription transactions"
```

## Task 3: Expose verified billing through the tRPC API

**Files:**
- Modify: `packages/server/src/routers/billing.ts`
- Modify: `packages/server/src/routers/billing.test.ts`
- Modify: `packages/server/src/billing/access-window-repository.ts`
- Modify: `packages/server/src/billing/access-window-repository.test.ts`

**Consumes:** Tasks 1–2 resolver, billing repository, and verifier.

**Produces:** `billing.appStorePurchaseContext`, `billing.verifyAppStoreTransaction`, and a status response that safely describes App Store access.

- [ ] **Step 1: Write failing router tests**

```ts
it("returns a stable App Store purchase context for the authenticated user", async () => {
  await expect(caller.appStorePurchaseContext()).resolves.toEqual({
    productId: "com.dofek.premium.monthly",
    appAccountToken: "a0000000-0000-4000-8000-000000000001",
  });
});

it("verifies a signed transaction for the authenticated account and returns full access", async () => {
  await expect(caller.verifyAppStoreTransaction({ signedTransaction: "verified-jws" })).resolves.toMatchObject({
    access: { kind: "full", reason: "app_store_subscription" },
  });
});
```

- [ ] **Step 2: Run focused router tests and verify RED**

Run: `pnpm vitest run --project unit packages/server/src/routers/billing.test.ts`

Expected: FAIL because the two procedures are absent.

- [ ] **Step 3: Add protected procedures with a single server authority**

`appStorePurchaseContext` uses `BillingRepository.getOrCreateAppStoreAccountToken(ctx.userId)` inside `withAccountErasureUserWriteFence`. `verifyAppStoreTransaction` accepts `{ signedTransaction: z.string().min(1) }`, loads the user token, verifies it, persists it through `applyAppStoreSubscription`, invalidates the user cache, and returns the same status shape as `billing.status`. Do not return Apple JWS or transaction IDs to the client.

Extend `billing.status` with an `appStoreSubscriptionStatus` nullable string and `canManageAppStoreSubscription` boolean. Preserve existing web Stripe actions and response fields.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `pnpm vitest run --project unit packages/server/src/routers/billing.test.ts packages/server/src/billing/access-window-repository.test.ts`

Expected: PASS, including the existing Stripe Checkout and portal tests.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/routers/billing.ts packages/server/src/routers/billing.test.ts packages/server/src/billing/access-window-repository.ts packages/server/src/billing/access-window-repository.test.ts
git commit -m "Add App Store billing API"
```

## Task 4: Process App Store Server Notifications V2

**Files:**
- Create: `packages/server/src/routes/app-store-webhook.ts`
- Create: `packages/server/src/routes/app-store-webhook.test.ts`
- Modify: `packages/server/src/index.ts:62-68,255-258`
- Modify: `src/account-erasure/postgres-erasure.ts`

**Consumes:** Task 2 verifier and `BillingRepository.applyAppStoreSubscription`.

**Produces:** A raw-body `POST /api/webhooks/app-store` endpoint that verifies V2 notifications and safely updates the matching account.

- [ ] **Step 1: Write failing route tests**

```ts
it("updates the subscription once for a verified DID_RENEW notification", async () => {
  const response = await request(router)
    .post("/")
    .set("content-type", "application/json")
    .send({ signedPayload: "verified-notification-jws" });
  expect(response.status).toBe(200);
  expect(applyAppStoreSubscription).toHaveBeenCalledOnce();
});

it("returns 400 and does not write when notification verification fails", async () => {
  verifier.verifyNotification.mockRejectedValueOnce(new Error("Apple signature is invalid"));
  const response = await request(router).post("/").send({ signedPayload: "invalid-jws" });
  expect(response.status).toBe(400);
  expect(applyAppStoreSubscription).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run focused route tests and verify RED**

Run: `pnpm vitest run --project unit packages/server/src/routes/app-store-webhook.test.ts`

Expected: FAIL because the route factory does not exist.

- [ ] **Step 3: Add the raw-body notification router**

Mount `app.use("/api/webhooks/app-store", createAppStoreWebhookRouter({ db }))` before `express.json()`, adjacent to the Stripe raw webhook. Parse a JSON body containing only `signedPayload`; use Apple’s `verifyAndDecodeNotification`; require a notification UUID; apply the decoded signed transaction/renewal state and record it in `fitness.app_store_notification` within the same transaction. Return `200 { received: true }` for a duplicate verified UUID, `400` for an invalid payload, and send unexpected internal errors to the shared Express error handler/Sentry.

Keep `fitness.app_store_notification` keyed only by Apple notification UUID and without a user foreign key, so account erasure does not delete the global replay-protection ledger.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `pnpm vitest run --project unit packages/server/src/routes/app-store-webhook.test.ts packages/server/src/routers/billing.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/routes/app-store-webhook.ts packages/server/src/routes/app-store-webhook.test.ts packages/server/src/index.ts src/account-erasure/postgres-erasure.ts
git commit -m "Handle App Store subscription notifications"
```

## Task 5: Build the StoreKit 2 Expo module

**Files:**
- Create: `packages/mobile/modules/app-store-billing/expo-module.config.json`
- Create: `packages/mobile/modules/app-store-billing/index.ts`
- Create: `packages/mobile/modules/app-store-billing/Package.swift`
- Create: `packages/mobile/modules/app-store-billing/ios/AppStoreBillingModule.swift`
- Create: `packages/mobile/modules/app-store-billing/ios/AppStoreBillingService.swift`
- Create: `packages/mobile/modules/app-store-billing/Tests/AppStoreBillingServiceTests.swift`
- Modify: `packages/mobile/test-setup.ts`

**Consumes:** StoreKit 2 and Task 3’s purchase-context shape.

**Produces:** JS functions `loadProduct`, `purchase`, `restoreCurrentEntitlements`, `startTransactionUpdates`, `stopTransactionUpdates`, `finishTransaction`, and `showManageSubscriptions`.

- [ ] **Step 1: Write failing XCTest cases for the StoreKit adapter**

```swift
func testPurchaseReturnsVerifiedSignedTransactionWithoutFinishingIt() async throws {
    let service = AppStoreBillingService(store: FakeStoreKit(product: product, purchase: .verified(transaction)))
    let result = try await service.purchase(productID: "com.dofek.premium.monthly", appAccountToken: token)
    XCTAssertEqual(result.signedTransaction, transaction.jwsRepresentation)
    XCTAssertEqual(store.finishedTransactionIDs, [])
}

func testRestoreSkipsUnverifiedTransactions() async throws {
    let service = AppStoreBillingService(store: FakeStoreKit(currentEntitlements: [.verified(expectedTransaction), .unverified(otherTransaction)]))
    let restored = try await service.restoreCurrentEntitlements(productID: "com.dofek.premium.monthly")
    XCTAssertEqual(restored.map(\\.transactionID), [expectedTransaction.id])
}
```

- [ ] **Step 2: Run XCTest and verify RED**

Run: `cd packages/mobile/modules/app-store-billing && swift test --filter AppStoreBillingServiceTests`

Expected: FAIL because the Swift package/module/service does not exist.

- [ ] **Step 3: Implement the minimal native module**

Add a Swift package manifest with an iOS 16/macOS 13 library target that excludes `AppStoreBillingModule.swift` and the Expo podspec from the pure StoreKit service target, mirroring `modules/health-kit/Package.swift`. Use `Product.products(for:)`, `Product.purchase(options: [.appAccountToken(UUID)])`, `Transaction.currentEntitlements`, and `Transaction.updates`. Export only verified transactions whose product ID equals `com.dofek.premium.monthly`. Return the JWS representation and transaction ID, but do not call `finish()` until JavaScript confirms server verification. Map user cancellation to `{ outcome: "cancelled" }`, not an error. Bridge `AppStore.showManageSubscriptions(in:)` through the current foreground view controller.

- [ ] **Step 4: Add the TypeScript bridge and Vitest mock**

Define exact discriminated result types in `index.ts`; add a native-module mock in `packages/mobile/test-setup.ts` that makes cancellation, verified purchase, restore, and update delivery controllable by mobile tests.

- [ ] **Step 5: Run XCTest and mobile typecheck, then commit**

Run: `cd packages/mobile/modules/app-store-billing && swift test && cd ../../../.. && pnpm --dir packages/mobile typecheck`

Commit:

```bash
git add packages/mobile/modules/app-store-billing packages/mobile/test-setup.ts
git commit -m "Add StoreKit billing module"
```

## Task 6: Coordinate StoreKit with the server

**Files:**
- Create: `packages/mobile/lib/app-store-billing.ts`
- Create: `packages/mobile/lib/app-store-billing.test.ts`
- Modify: `packages/mobile/app/_layout.tsx`

**Consumes:** Tasks 3 and 5.

**Produces:** `AppStoreBillingService` that purchases/restores/observes transactions, verifies each with the server, finishes accepted transactions, and invalidates billing queries.

- [ ] **Step 1: Write failing service tests**

```ts
it("finishes a purchase only after server verification succeeds", async () => {
  await service.subscribe();
  expect(trpc.billing.verifyAppStoreTransaction.mutate).toHaveBeenCalledWith({ signedTransaction: "verified-jws" });
  expect(native.finishTransaction).toHaveBeenCalledWith("transaction-1");
});

it("does not finish a transaction when the server rejects it", async () => {
  trpc.billing.verifyAppStoreTransaction.mutate.mockRejectedValueOnce(new Error("Transaction belongs to another Dofek account."));
  await expect(service.subscribe()).rejects.toThrow("Transaction belongs to another Dofek account.");
  expect(native.finishTransaction).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run focused service tests and verify RED**

Run: `pnpm vitest run --project mobile packages/mobile/lib/app-store-billing.test.ts`

Expected: FAIL because the service is absent.

- [ ] **Step 3: Implement the coordinator**

`subscribe()` loads `billing.appStorePurchaseContext`, asks native StoreKit to purchase, sends the returned JWS to `billing.verifyAppStoreTransaction`, finishes only on success, then invalidates `billing.status`. `restore()` repeats this for every native current entitlement. Transaction-update observation starts only after authentication and stops on sign-out; each update follows the same verify-then-finish path. All unexpected errors call `captureException` with operation-specific context and preserve `error.message` for Settings.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `pnpm vitest run --project mobile packages/mobile/lib/app-store-billing.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mobile/lib/app-store-billing.ts packages/mobile/lib/app-store-billing.test.ts packages/mobile/app/_layout.tsx
git commit -m "Verify StoreKit transactions with Dofek"
```

## Task 7: Replace iOS billing Settings actions

**Files:**
- Modify: `packages/mobile/app/settings.tsx`
- Modify: `packages/mobile/app-tests/settings.test.tsx`
- Modify: `packages/web/src/pages/SettingsPage.tsx`
- Modify: `packages/web/src/pages/SettingsPage.test.tsx`
- Delete: `packages/mobile/lib/billing-checkout-operation.ts`
- Delete: `packages/mobile/lib/billing-checkout-operation.test.ts`

**Consumes:** Task 6 service and Task 3 billing status.

**Produces:** iOS StoreKit-only subscription UI and an unchanged Stripe-web checkout UI that renders an App Store full-access state correctly.

- [ ] **Step 1: Write failing Settings tests**

```tsx
it("starts a StoreKit subscription instead of opening Stripe Checkout on iOS", async () => {
  render(<SettingsScreen />);
  await user.press(screen.getByRole("button", { name: "Subscribe for $4.99/month" }));
  expect(mockAppStoreBilling.subscribe).toHaveBeenCalledOnce();
  expect(Linking.openURL).not.toHaveBeenCalled();
});

it("opens Apple subscription management for an App Store subscriber", async () => {
  render(<SettingsScreen />);
  await user.press(screen.getByRole("button", { name: "Manage Subscription" }));
  expect(mockAppStoreBilling.showManageSubscriptions).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm vitest run --project mobile packages/mobile/app-tests/settings.test.tsx`

Expected: FAIL because the StoreKit controls are not rendered.

- [ ] **Step 3: Implement platform-specific billing actions**

On iOS, replace `createCheckoutSession`, `createPortalSession`, `Linking.openURL`, and SecureStore checkout-operation code with `AppStoreBillingService.subscribe`, `restore`, and `showManageSubscriptions`. Show the exact price in the subscribe control, “Restore Purchases,” and “Manage Subscription” only when `canManageAppStoreSubscription` is true. Render the specific server error message. Keep web Settings wired to Stripe Checkout/Portal; change its full-access copy to generic “Full access is enabled” when the reason is App Store.

- [ ] **Step 4: Delete obsolete Stripe-only mobile operation code**

Remove the mobile checkout-operation imports, test setup, source file, and its tests. Do not leave compatibility aliases.

- [ ] **Step 5: Run Settings suites and verify GREEN**

Run: `pnpm vitest run --project mobile packages/mobile/app-tests/settings.test.tsx && pnpm vitest run --project unit packages/web/src/pages/SettingsPage.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/mobile/app/settings.tsx packages/mobile/app-tests/settings.test.tsx packages/web/src/pages/SettingsPage.tsx packages/web/src/pages/SettingsPage.test.tsx
git rm packages/mobile/lib/billing-checkout-operation.ts packages/mobile/lib/billing-checkout-operation.test.ts
git commit -m "Use StoreKit billing on iOS"
```

## Task 8: Configure Apple, secrets, and release evidence

**Files:**
- Modify: `.env.example`
- Modify: `docs/ios-physical-device-release-audit.md`
- Modify: `deploy/README.md`
- Modify: `packages/web/src/routes/privacy.tsx`

**Consumes:** Tasks 1–7 and App Store Connect access.

**Produces:** A reviewable App Store product, live server configuration, and an operator-auditable sandbox/review trail.

- [ ] **Step 1: Add fail-fast configuration documentation and a failing config test**

Add example variable names without secret values to `.env.example`. Add `packages/server/src/billing/app-store-config.test.ts` asserting an absent `APP_STORE_PRIVATE_KEY` throws `APP_STORE_PRIVATE_KEY environment variable is required`.

- [ ] **Step 2: Run the config test and verify RED, then implement/verify GREEN**

Run: `pnpm vitest run --project unit packages/server/src/billing/app-store-config.test.ts`

Expected before Task 2 implementation: FAIL; expected after Task 2: PASS.

- [ ] **Step 3: Create and validate App Store Connect configuration**

Create `Dofek Premium`, create `com.dofek.premium.monthly` at $4.99/month, supply all required localized subscription metadata, attach it to the review submission, create an In-App Purchase server API key, and configure the production deployment's existing public base URL plus `/api/webhooks/app-store` as the Notifications V2 URL. Store the Apple key material and identifiers in Infisical for staging and production, then restart/redeploy the server only after `getAppStoreBillingConfig()` can load every required value.

- [ ] **Step 4: Document the physical validation and privacy disclosure**

Add exact audit steps: sandbox purchase; server JWS acceptance; restore after reinstall; Apple-managed subscription screen; renewal/update notification; cancellation/expiry; refund/revocation notification; and account deletion. Update the privacy policy to identify Apple as a payment processor for App Store subscriptions and keep the existing Stripe disclosure for web purchases.

- [ ] **Step 5: Run final validation and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test:changed:all`

Then perform the documented physical-device sandbox audit against the TestFlight candidate and record the transaction IDs only in secure operational evidence, never in the repository.

Commit:

```bash
git add .env.example docs/ios-physical-device-release-audit.md deploy/README.md packages/web/src/routes/privacy.tsx packages/server/src/billing/app-store-config.test.ts
git commit -m "Document App Store subscription operations"
```

## Plan Self-Review

- **Spec coverage:** Tasks 1–4 cover server authority, persistence, JWS verification, and Notifications V2. Tasks 5–7 cover native purchase, restore, updates, management, and replacement of iOS Stripe actions. Task 8 covers App Store Connect, Infisical, privacy, and physical validation.
- **No-placeholder check:** The plan defines the product, price, route, variable names, module functions, server procedures, and concrete test commands.
- **Type consistency:** `AppStoreSubscriptionUpdate` flows from the verifier to `BillingRepository.applyAppStoreSubscription`; `billing.appStorePurchaseContext` supplies the token/product used by the native coordinator; `billing.verifyAppStoreTransaction` is the only mobile-to-server verification mutation.
