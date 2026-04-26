# Stripe Subscriptions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Stripe subscriptions with server-side read gating so unpaid users can only read the seven calendar days starting at signup while syncing remains unrestricted.

**Architecture:** Stripe Checkout and the Customer Portal handle payment flows. The server stores local billing state updated by verified Stripe webhooks, derives an access window per authenticated user, and applies that window in repositories/routes before data leaves the API. Web and mobile render subscription state and open Stripe-hosted URLs; they do not compute entitlement.

**Tech Stack:** TypeScript, Express, tRPC, Drizzle SQL migrations, Stripe Node SDK `22.1.0`, Vitest, React, React Native.

---

## File Structure

- Create `packages/server/src/billing/entitlement.ts`: pure entitlement/window logic.
- Create `packages/server/src/billing/config.ts`: fail-fast Stripe env parsing.
- Create `packages/server/src/billing/stripe-client.ts`: Stripe client factory and test seam.
- Create `packages/server/src/repositories/billing-repository.ts`: local billing persistence.
- Create `packages/server/src/routers/billing.ts`: tRPC status/checkout/portal procedures.
- Create `packages/server/src/routes/stripe-webhook.ts`: raw-body Stripe webhook route.
- Modify `src/db/schema.ts`: add `userBilling` table.
- Add `drizzle/0002_add_user_billing.sql`: forward-only migration and existing-user backfill.
- Modify `packages/server/src/trpc.ts`: add authenticated context field for `accessWindow`.
- Modify `packages/server/src/lib/base-repository.ts`: optional access-window SQL helpers.
- Modify read repositories and routers that return user health data: activity, daily metrics, sleep, body, food, nutrition, journal, life events, calendar, reports, predictions, insights, training, recovery, stress, trends, exports, and analytics routers.
- Modify `packages/server/src/router.ts` and `packages/server/src/router.test.ts`: register billing router.
- Modify `packages/server/src/index.ts`: mount Stripe webhook before body parsing-sensitive routes.
- Modify `packages/web/src/pages/SettingsPage.tsx`: add billing section.
- Create `packages/web/src/components/BillingPanel.tsx` and `packages/web/src/components/BillingPanel.test.tsx`.
- Modify `packages/mobile/app/settings.tsx` and `packages/mobile/app/settings.test.tsx`: add billing section and actions.
- Update docs after implementation: `README.md`, `packages/server/README.md`, and Infisical/Stripe setup notes in `docs/README.md` or a dedicated `docs/stripe-billing.md`.

## Task 1: Stripe Dependency And Billing Schema

**Files:**
- Modify: `packages/server/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `src/db/schema.ts`
- Create: `drizzle/0002_add_user_billing.sql`
- Test: `packages/server/src/repositories/billing-repository.test.ts`

- [ ] **Step 1: Add Stripe SDK**

Run:

```bash
pnpm --filter dofek-server add stripe@22.1.0
```

Expected: `packages/server/package.json` contains `"stripe": "22.1.0"` and `pnpm-lock.yaml` updates.

- [ ] **Step 2: Write failing repository test for missing billing row**

Create `packages/server/src/repositories/billing-repository.test.ts`:

```ts
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { BillingRepository } from "./billing-repository.ts";

describe("BillingRepository", () => {
  it("returns null when a user has no billing row", async () => {
    const execute = vi.fn(async () => []);
    const repo = new BillingRepository({ execute });

    await expect(repo.findByUserId("user-1")).resolves.toBeNull();
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ queryChunks: expect.any(Array) }));
  });

  it("upserts an existing-account paid grant", async () => {
    const execute = vi.fn(async () => []);
    const repo = new BillingRepository({ execute });

    await repo.upsertPaidGrant("user-1", "existing_account");

    const queryText = String(execute.mock.calls[0]?.[0]);
    expect(queryText).toContain("fitness.user_billing");
    expect(queryText).toContain("paid_grant_reason");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run:

```bash
pnpm vitest packages/server/src/repositories/billing-repository.test.ts
```

Expected: FAIL because `./billing-repository.ts` does not exist.

- [ ] **Step 4: Add schema table**

In `src/db/schema.ts`, after `session`, add:

```ts
export const userBilling = fitness.table(
  "user_billing",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => userProfile.id, { onDelete: "cascade" }),
    stripeCustomerId: text("stripe_customer_id").unique(),
    stripeSubscriptionId: text("stripe_subscription_id").unique(),
    stripeSubscriptionStatus: text("stripe_subscription_status"),
    stripeCurrentPeriodEnd: timestamp("stripe_current_period_end", { withTimezone: true }),
    paidGrantReason: text("paid_grant_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("user_billing_stripe_customer_idx").on(table.stripeCustomerId),
    index("user_billing_stripe_subscription_idx").on(table.stripeSubscriptionId),
  ],
);
```

- [ ] **Step 5: Add manual migration**

Create `drizzle/0002_add_user_billing.sql`:

```sql
CREATE TABLE fitness.user_billing (
  user_id uuid PRIMARY KEY REFERENCES fitness.user_profile(id) ON DELETE CASCADE,
  stripe_customer_id text UNIQUE,
  stripe_subscription_id text UNIQUE,
  stripe_subscription_status text,
  stripe_current_period_end timestamptz,
  paid_grant_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX user_billing_stripe_customer_idx ON fitness.user_billing(stripe_customer_id);
CREATE INDEX user_billing_stripe_subscription_idx ON fitness.user_billing(stripe_subscription_id);

INSERT INTO fitness.user_billing (user_id, paid_grant_reason)
SELECT id, 'existing_account'
FROM fitness.user_profile
ON CONFLICT (user_id) DO NOTHING;
```

- [ ] **Step 6: Implement repository**

Create `packages/server/src/repositories/billing-repository.ts`:

```ts
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";

type BillingDatabase = Pick<Database, "execute">;

export const billingRowSchema = z.object({
  user_id: z.string(),
  stripe_customer_id: z.string().nullable(),
  stripe_subscription_id: z.string().nullable(),
  stripe_subscription_status: z.string().nullable(),
  stripe_current_period_end: timestampStringSchema.nullable(),
  paid_grant_reason: z.string().nullable(),
  created_at: timestampStringSchema,
  updated_at: timestampStringSchema,
});

export type BillingRow = z.infer<typeof billingRowSchema>;

export class BillingRepository {
  readonly #db: BillingDatabase;

  constructor(db: BillingDatabase) {
    this.#db = db;
  }

  async findByUserId(userId: string): Promise<BillingRow | null> {
    const rows = await executeWithSchema(
      this.#db,
      billingRowSchema,
      sql`SELECT
            user_id,
            stripe_customer_id,
            stripe_subscription_id,
            stripe_subscription_status,
            stripe_current_period_end::text AS stripe_current_period_end,
            paid_grant_reason,
            created_at::text AS created_at,
            updated_at::text AS updated_at
          FROM fitness.user_billing
          WHERE user_id = ${userId}
          LIMIT 1`,
    );
    return rows[0] ?? null;
  }

  async upsertPaidGrant(userId: string, reason: string): Promise<void> {
    await this.#db.execute(
      sql`INSERT INTO fitness.user_billing (user_id, paid_grant_reason)
          VALUES (${userId}, ${reason})
          ON CONFLICT (user_id) DO UPDATE SET
            paid_grant_reason = EXCLUDED.paid_grant_reason,
            updated_at = now()`,
    );
  }
}
```

- [ ] **Step 7: Run test to verify it passes**

Run:

```bash
pnpm vitest packages/server/src/repositories/billing-repository.test.ts
```

Expected: PASS.

- [ ] **Step 8: Run migration**

Run:

```bash
pnpm migrate
```

Expected: migration applies and schema diagram generation completes.

- [ ] **Step 9: Commit**

```bash
git add packages/server/package.json pnpm-lock.yaml src/db/schema.ts drizzle/0002_add_user_billing.sql packages/server/src/repositories/billing-repository.ts packages/server/src/repositories/billing-repository.test.ts docs/schema.*
git commit -m "feat: add billing schema"
```

## Task 2: Entitlement And Access Window Core

**Files:**
- Create: `packages/server/src/billing/entitlement.ts`
- Test: `packages/server/src/billing/entitlement.test.ts`

- [ ] **Step 1: Write failing entitlement tests**

Create `packages/server/src/billing/entitlement.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveAccessWindow } from "./entitlement.ts";

describe("resolveAccessWindow", () => {
  it("grants full access for existing-account paid grants", () => {
    const result = resolveAccessWindow({
      userCreatedAt: "2026-04-10T18:30:00.000Z",
      paidGrantReason: "existing_account",
      stripeSubscriptionStatus: null,
    });

    expect(result).toEqual({ kind: "full", paid: true, reason: "paid_grant" });
  });

  it("grants full access for active Stripe subscriptions", () => {
    const result = resolveAccessWindow({
      userCreatedAt: "2026-04-10T18:30:00.000Z",
      paidGrantReason: null,
      stripeSubscriptionStatus: "active",
    });

    expect(result).toEqual({ kind: "full", paid: true, reason: "stripe_subscription" });
  });

  it("limits unpaid users to signup day through signup day plus six", () => {
    const result = resolveAccessWindow({
      userCreatedAt: "2026-04-10T18:30:00.000Z",
      paidGrantReason: null,
      stripeSubscriptionStatus: "canceled",
    });

    expect(result).toEqual({
      kind: "limited",
      paid: false,
      reason: "free_signup_week",
      startDate: "2026-04-10",
      endDateExclusive: "2026-04-17",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest packages/server/src/billing/entitlement.test.ts
```

Expected: FAIL because `entitlement.ts` does not exist.

- [ ] **Step 3: Implement pure entitlement logic**

Create `packages/server/src/billing/entitlement.ts`:

```ts
const ACCESS_GRANTING_STRIPE_STATUSES = new Set(["active", "trialing"]);

export type AccessWindow =
  | { kind: "full"; paid: true; reason: "paid_grant" | "stripe_subscription" }
  | {
      kind: "limited";
      paid: false;
      reason: "free_signup_week";
      startDate: string;
      endDateExclusive: string;
    };

export interface ResolveAccessWindowInput {
  userCreatedAt: string;
  paidGrantReason: string | null;
  stripeSubscriptionStatus: string | null;
}

function toDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function resolveAccessWindow(input: ResolveAccessWindowInput): AccessWindow {
  if (input.paidGrantReason) {
    return { kind: "full", paid: true, reason: "paid_grant" };
  }

  if (
    input.stripeSubscriptionStatus &&
    ACCESS_GRANTING_STRIPE_STATUSES.has(input.stripeSubscriptionStatus)
  ) {
    return { kind: "full", paid: true, reason: "stripe_subscription" };
  }

  const start = new Date(input.userCreatedAt);
  const startUtcMidnight = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()),
  );
  const endExclusive = new Date(startUtcMidnight);
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 7);

  return {
    kind: "limited",
    paid: false,
    reason: "free_signup_week",
    startDate: toDateOnly(startUtcMidnight),
    endDateExclusive: toDateOnly(endExclusive),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm vitest packages/server/src/billing/entitlement.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/billing/entitlement.ts packages/server/src/billing/entitlement.test.ts
git commit -m "feat: derive billing access window"
```

## Task 3: Billing Config, Stripe Client, And Status API

**Files:**
- Create: `packages/server/src/billing/config.ts`
- Create: `packages/server/src/billing/stripe-client.ts`
- Create: `packages/server/src/routers/billing.ts`
- Modify: `packages/server/src/router.ts`
- Modify: `packages/server/src/router.test.ts`
- Test: `packages/server/src/routers/billing.test.ts`

- [ ] **Step 1: Write failing billing router status test**

Create `packages/server/src/routers/billing.test.ts` with the local tRPC mock pattern:

```ts
import { describe, expect, it, vi } from "vitest";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC.context<{ db: { execute: unknown }; userId: string; timezone: string }>().create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
  };
});

vi.mock("../lib/typed-sql.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/typed-sql.ts")>();
  return {
    ...original,
    executeWithSchema: vi.fn(async () => [
      {
        id: "user-1",
        created_at: "2026-04-10T18:30:00.000Z",
        paid_grant_reason: null,
        stripe_subscription_status: null,
        stripe_customer_id: null,
      },
    ]),
  };
});

import { createTestCallerFactory } from "./test-helpers.ts";
import { billingRouter } from "./billing.ts";

const createCaller = createTestCallerFactory(billingRouter);

describe("billingRouter", () => {
  it("returns limited signup-week status for unpaid users", async () => {
    const caller = createCaller({ db: { execute: vi.fn() }, userId: "user-1", timezone: "UTC" });

    await expect(caller.status()).resolves.toEqual({
      hasFullAccess: false,
      access: {
        kind: "limited",
        paid: false,
        reason: "free_signup_week",
        startDate: "2026-04-10",
        endDateExclusive: "2026-04-17",
      },
      stripeSubscriptionStatus: null,
      canManageBilling: false,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest packages/server/src/routers/billing.test.ts
```

Expected: FAIL because `billing.ts` does not exist.

- [ ] **Step 3: Implement config and status route**

Create `packages/server/src/billing/config.ts`:

```ts
export interface StripeBillingConfig {
  secretKey: string;
  webhookSecret: string;
  priceId: string;
  appBaseUrl: string;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} environment variable is required`);
  return value;
}

export function getStripeBillingConfig(): StripeBillingConfig {
  return {
    secretKey: requiredEnv("STRIPE_SECRET_KEY"),
    webhookSecret: requiredEnv("STRIPE_WEBHOOK_SECRET"),
    priceId: requiredEnv("STRIPE_PRICE_ID"),
    appBaseUrl: requiredEnv("APP_BASE_URL"),
  };
}
```

Create `packages/server/src/billing/stripe-client.ts`:

```ts
import Stripe from "stripe";
import { getStripeBillingConfig } from "./config.ts";

export function createStripeClient(): Stripe {
  const config = getStripeBillingConfig();
  return new Stripe(config.secretKey);
}
```

Create `packages/server/src/routers/billing.ts`:

```ts
import { sql } from "drizzle-orm";
import { z } from "zod";
import { resolveAccessWindow } from "../billing/entitlement.ts";
import { executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import { protectedProcedure, router } from "../trpc.ts";

const statusRowSchema = z.object({
  id: z.string(),
  created_at: timestampStringSchema,
  paid_grant_reason: z.string().nullable(),
  stripe_subscription_status: z.string().nullable(),
  stripe_customer_id: z.string().nullable(),
});

export const billingRouter = router({
  status: protectedProcedure.query(async ({ ctx }) => {
    const rows = await executeWithSchema(
      ctx.db,
      statusRowSchema,
      sql`SELECT
            up.id,
            up.created_at::text AS created_at,
            ub.paid_grant_reason,
            ub.stripe_subscription_status,
            ub.stripe_customer_id
          FROM fitness.user_profile up
          LEFT JOIN fitness.user_billing ub ON ub.user_id = up.id
          WHERE up.id = ${ctx.userId}
          LIMIT 1`,
    );
    const row = rows[0];
    if (!row) throw new Error("Authenticated user profile not found");

    const access = resolveAccessWindow({
      userCreatedAt: row.created_at,
      paidGrantReason: row.paid_grant_reason,
      stripeSubscriptionStatus: row.stripe_subscription_status,
    });

    return {
      hasFullAccess: access.kind === "full",
      access,
      stripeSubscriptionStatus: row.stripe_subscription_status,
      canManageBilling: row.stripe_customer_id != null,
    };
  }),
});
```

- [ ] **Step 4: Register billing router**

Modify `packages/server/src/router.ts`:

```ts
import { billingRouter } from "./routers/billing.ts";
```

Add to `appRouter`:

```ts
billing: billingRouter,
```

Modify `packages/server/src/router.test.ts`:

```ts
vi.mock("./routers/billing.ts", () => ({ billingRouter: mockRouter }));
```

Add `"billing"` to `expectedRouters`.

- [ ] **Step 5: Run tests**

```bash
pnpm vitest packages/server/src/routers/billing.test.ts packages/server/src/router.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/billing/config.ts packages/server/src/billing/stripe-client.ts packages/server/src/routers/billing.ts packages/server/src/routers/billing.test.ts packages/server/src/router.ts packages/server/src/router.test.ts
git commit -m "feat: expose billing status"
```

## Task 4: Checkout, Customer Portal, And Stripe Webhooks

**Files:**
- Modify: `packages/server/src/routers/billing.ts`
- Create: `packages/server/src/routes/stripe-webhook.ts`
- Modify: `packages/server/src/index.ts`
- Modify: `packages/server/src/repositories/billing-repository.ts`
- Test: `packages/server/src/routers/billing.test.ts`
- Test: `packages/server/src/routes/stripe-webhook.test.ts`

- [ ] **Step 1: Add failing checkout and portal tests**

Extend `billing.test.ts` with mocked `createStripeClient()` and `getStripeBillingConfig()`:

```ts
vi.mock("../billing/config.ts", () => ({
  getStripeBillingConfig: () => ({
    secretKey: "sk_test_123",
    webhookSecret: "whsec_123",
    priceId: "price_123",
    appBaseUrl: "https://app.example.com",
  }),
}));

const checkoutCreate = vi.fn(async () => ({ url: "https://checkout.stripe.test/session" }));
const portalCreate = vi.fn(async () => ({ url: "https://billing.stripe.test/session" }));

vi.mock("../billing/stripe-client.ts", () => ({
  createStripeClient: () => ({
    checkout: { sessions: { create: checkoutCreate } },
    billingPortal: { sessions: { create: portalCreate } },
    customers: { create: vi.fn(async () => ({ id: "cus_123" })) },
  }),
}));
```

Add tests:

```ts
it("creates a checkout session for the configured subscription price", async () => {
  const caller = createCaller({ db: { execute: vi.fn(async () => []) }, userId: "user-1", timezone: "UTC" });

  await expect(caller.createCheckoutSession()).resolves.toEqual({
    url: "https://checkout.stripe.test/session",
  });
  expect(checkoutCreate).toHaveBeenCalledWith(
    expect.objectContaining({
      mode: "subscription",
      line_items: [{ price: "price_123", quantity: 1 }],
      success_url: "https://app.example.com/settings?billing=success",
      cancel_url: "https://app.example.com/settings?billing=cancel",
    }),
  );
});

it("creates a portal session for an existing Stripe customer", async () => {
  const caller = createCaller({ db: { execute: vi.fn(async () => []) }, userId: "user-1", timezone: "UTC" });

  await expect(caller.createPortalSession()).resolves.toEqual({
    url: "https://billing.stripe.test/session",
  });
  expect(portalCreate).toHaveBeenCalledWith({
    customer: "cus_123",
    return_url: "https://app.example.com/settings",
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm vitest packages/server/src/routers/billing.test.ts
```

Expected: FAIL because checkout and portal procedures do not exist.

- [ ] **Step 3: Implement procedures**

Add to `billingRouter`:

```ts
createCheckoutSession: protectedProcedure.mutation(async ({ ctx }) => {
  const config = getStripeBillingConfig();
  const stripe = createStripeClient();
  const customerId = await ensureStripeCustomer(ctx.db, ctx.userId, stripe);
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [{ price: config.priceId, quantity: 1 }],
    success_url: `${config.appBaseUrl}/settings?billing=success`,
    cancel_url: `${config.appBaseUrl}/settings?billing=cancel`,
    client_reference_id: ctx.userId,
  });
  if (!session.url) throw new Error("Stripe Checkout did not return a session URL");
  return { url: session.url };
}),

createPortalSession: protectedProcedure.mutation(async ({ ctx }) => {
  const config = getStripeBillingConfig();
  const stripe = createStripeClient();
  const customerId = await getStripeCustomerId(ctx.db, ctx.userId);
  if (!customerId) throw new Error("Stripe customer not found. Subscribe before managing billing.");
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${config.appBaseUrl}/settings`,
  });
  return { url: session.url };
}),
```

Implement `ensureStripeCustomer()` and `getStripeCustomerId()` in the same router or move them into `BillingRepository` if the file grows beyond readability.

- [ ] **Step 4: Add failing webhook tests**

Create `packages/server/src/routes/stripe-webhook.test.ts`:

```ts
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createStripeWebhookRouter } from "./stripe-webhook.ts";

const constructEvent = vi.fn();

vi.mock("../billing/config.ts", () => ({
  getStripeBillingConfig: () => ({
    secretKey: "sk_test_123",
    webhookSecret: "whsec_123",
    priceId: "price_123",
    appBaseUrl: "https://app.example.com",
  }),
}));

vi.mock("../billing/stripe-client.ts", () => ({
  createStripeClient: () => ({
    webhooks: { constructEvent },
  }),
}));

describe("stripe webhook route", () => {
  it("updates local subscription state for customer.subscription.updated", async () => {
    constructEvent.mockReturnValue({
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_123",
          customer: "cus_123",
          status: "active",
          current_period_end: 1_777_000_000,
        },
      },
    });
    const execute = vi.fn(async () => []);
    const app = express();
    app.use("/api/webhooks/stripe", createStripeWebhookRouter({ db: { execute } }));

    const response = await request(app)
      .post("/api/webhooks/stripe")
      .set("stripe-signature", "sig")
      .send(Buffer.from("{}"));

    expect(response.status).toBe(200);
    expect(execute).toHaveBeenCalled();
  });
});
```

- [ ] **Step 5: Run webhook test to verify it fails**

```bash
pnpm vitest packages/server/src/routes/stripe-webhook.test.ts
```

Expected: FAIL because route does not exist.

- [ ] **Step 6: Implement webhook route and mount it**

Create `packages/server/src/routes/stripe-webhook.ts`:

```ts
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import express from "express";
import Stripe from "stripe";
import { getStripeBillingConfig } from "../billing/config.ts";
import { createStripeClient } from "../billing/stripe-client.ts";

export function createStripeWebhookRouter(deps: { db: Pick<Database, "execute"> }) {
  const router = express.Router();
  router.post("/", express.raw({ type: "application/json" }), async (req, res, next) => {
    try {
      const signature = req.header("stripe-signature");
      if (!signature) {
        res.status(400).send("Missing Stripe signature");
        return;
      }
      const stripe = createStripeClient();
      const config = getStripeBillingConfig();
      const event = stripe.webhooks.constructEvent(req.body, signature, config.webhookSecret);
      await handleStripeEvent(deps.db, event);
      res.json({ received: true });
    } catch (error) {
      next(error);
    }
  });
  return router;
}

async function handleStripeEvent(db: Pick<Database, "execute">, event: Stripe.Event) {
  if (
    event.type !== "customer.subscription.created" &&
    event.type !== "customer.subscription.updated" &&
    event.type !== "customer.subscription.deleted"
  ) {
    return;
  }
  const subscription = event.data.object as Stripe.Subscription;
  const customerId =
    typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
  const periodEnd =
    "current_period_end" in subscription && typeof subscription.current_period_end === "number"
      ? new Date(subscription.current_period_end * 1000).toISOString()
      : null;
  await db.execute(
    sql`UPDATE fitness.user_billing
        SET stripe_subscription_id = ${subscription.id},
            stripe_subscription_status = ${subscription.status},
            stripe_current_period_end = ${periodEnd},
            updated_at = now()
        WHERE stripe_customer_id = ${customerId}`,
  );
}
```

Modify `packages/server/src/index.ts` before existing webhook routes:

```ts
import { createStripeWebhookRouter } from "./routes/stripe-webhook.ts";
```

Mount:

```ts
app.use("/api/webhooks/stripe", createStripeWebhookRouter({ db }));
```

- [ ] **Step 7: Run tests**

```bash
pnpm vitest packages/server/src/routers/billing.test.ts packages/server/src/routes/stripe-webhook.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/routers/billing.ts packages/server/src/routers/billing.test.ts packages/server/src/routes/stripe-webhook.ts packages/server/src/routes/stripe-webhook.test.ts packages/server/src/index.ts packages/server/src/repositories/billing-repository.ts
git commit -m "feat: add stripe checkout and webhooks"
```

## Task 5: Access Window In tRPC Context And BaseRepository

**Files:**
- Modify: `packages/server/src/trpc.ts`
- Modify: `packages/server/src/lib/base-repository.ts`
- Test: `packages/server/src/trpc.test.ts`
- Test: `packages/server/src/lib/base-repository.test.ts`

- [ ] **Step 1: Write failing BaseRepository SQL helper test**

Create or extend `packages/server/src/lib/base-repository.test.ts`:

```ts
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { BaseRepository } from "./base-repository.ts";
import type { AccessWindow } from "../billing/entitlement.ts";

class TestRepository extends BaseRepository {
  timestampPredicate(columnSql = sql`started_at`) {
    return this.timestampAccessPredicate(columnSql);
  }
}

describe("BaseRepository access-window helpers", () => {
  it("returns an empty predicate for full access", () => {
    const accessWindow: AccessWindow = { kind: "full", paid: true, reason: "paid_grant" };
    const repo = new TestRepository({ execute: async () => [] }, "user-1", "UTC", accessWindow);

    expect(String(repo.timestampPredicate())).toBe("");
  });

  it("returns bounded timestamp predicate for limited access", () => {
    const accessWindow: AccessWindow = {
      kind: "limited",
      paid: false,
      reason: "free_signup_week",
      startDate: "2026-04-10",
      endDateExclusive: "2026-04-17",
    };
    const repo = new TestRepository({ execute: async () => [] }, "user-1", "UTC", accessWindow);

    expect(String(repo.timestampPredicate())).toContain("2026-04-10");
    expect(String(repo.timestampPredicate())).toContain("2026-04-17");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest packages/server/src/lib/base-repository.test.ts
```

Expected: FAIL because constructor/helper does not exist.

- [ ] **Step 3: Implement BaseRepository helpers**

Modify constructor and helpers:

```ts
import type { AccessWindow } from "../billing/entitlement.ts";
```

Add field:

```ts
protected readonly accessWindow: AccessWindow;
```

Update constructor:

```ts
constructor(
  db: TDb,
  userId: string,
  timezone = "UTC",
  accessWindow: AccessWindow = { kind: "full", paid: true, reason: "paid_grant" },
) {
  this.db = db;
  this.userId = userId;
  this.timezone = timezone;
  this.accessWindow = accessWindow;
}
```

Add helpers:

```ts
protected dateAccessPredicate(column: SQL): SQL {
  if (this.accessWindow.kind === "full") return sql``;
  return sql`AND ${column} >= ${this.accessWindow.startDate}::date
             AND ${column} < ${this.accessWindow.endDateExclusive}::date`;
}

protected timestampAccessPredicate(column: SQL): SQL {
  if (this.accessWindow.kind === "full") return sql``;
  return sql`AND ${column} >= ${this.accessWindow.startDate}::date
             AND ${column} < ${this.accessWindow.endDateExclusive}::date`;
}
```

- [ ] **Step 4: Add context access window resolver**

Modify `packages/server/src/trpc.ts`:

```ts
import type { AccessWindow } from "./billing/entitlement.ts";
```

Add to `Context`:

```ts
accessWindow?: AccessWindow;
```

Add to `AuthenticatedContext`:

```ts
accessWindow: AccessWindow;
```

Update auth middleware to resolve access:

```ts
const accessWindow = ctx.accessWindow ?? { kind: "full" as const, paid: true as const, reason: "paid_grant" as const };
const authenticatedCtx: AuthenticatedContext = { ...ctx, userId: ctx.userId, accessWindow };
```

The Express tRPC context in Task 6 will pass the real access window; tests can keep the full-access default.

- [ ] **Step 5: Run tests**

```bash
pnpm vitest packages/server/src/lib/base-repository.test.ts packages/server/src/routers/activity.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/trpc.ts packages/server/src/lib/base-repository.ts packages/server/src/lib/base-repository.test.ts
git commit -m "feat: add server access window helpers"
```

## Task 6: Resolve Access Window Per Request

**Files:**
- Create: `packages/server/src/billing/access-window-repository.ts`
- Modify: `packages/server/src/index.ts`
- Test: `packages/server/src/billing/access-window-repository.test.ts`
- Test: `packages/server/src/trpc.test.ts`

- [ ] **Step 1: Write failing access-window repository test**

Create `packages/server/src/billing/access-window-repository.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { getAccessWindowForUser } from "./access-window-repository.ts";

describe("getAccessWindowForUser", () => {
  it("derives limited access from user profile and billing state", async () => {
    const db = {
      execute: vi.fn(async () => [
        {
          created_at: "2026-04-10T18:30:00.000Z",
          paid_grant_reason: null,
          stripe_subscription_status: null,
        },
      ]),
    };

    await expect(getAccessWindowForUser(db, "user-1")).resolves.toEqual({
      kind: "limited",
      paid: false,
      reason: "free_signup_week",
      startDate: "2026-04-10",
      endDateExclusive: "2026-04-17",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest packages/server/src/billing/access-window-repository.test.ts
```

Expected: FAIL because file does not exist.

- [ ] **Step 3: Implement repository**

Create `packages/server/src/billing/access-window-repository.ts`:

```ts
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import { resolveAccessWindow, type AccessWindow } from "./entitlement.ts";

const accessWindowRowSchema = z.object({
  created_at: timestampStringSchema,
  paid_grant_reason: z.string().nullable(),
  stripe_subscription_status: z.string().nullable(),
});

export async function getAccessWindowForUser(
  db: Pick<Database, "execute">,
  userId: string,
): Promise<AccessWindow> {
  const rows = await executeWithSchema(
    db,
    accessWindowRowSchema,
    sql`SELECT
          up.created_at::text AS created_at,
          ub.paid_grant_reason,
          ub.stripe_subscription_status
        FROM fitness.user_profile up
        LEFT JOIN fitness.user_billing ub ON ub.user_id = up.id
        WHERE up.id = ${userId}
        LIMIT 1`,
  );
  const row = rows[0];
  if (!row) throw new Error("Authenticated user profile not found");
  return resolveAccessWindow({
    userCreatedAt: row.created_at,
    paidGrantReason: row.paid_grant_reason,
    stripeSubscriptionStatus: row.stripe_subscription_status,
  });
}
```

- [ ] **Step 4: Wire real access window into tRPC context**

Modify `packages/server/src/index.ts`:

```ts
import { getAccessWindowForUser } from "./billing/access-window-repository.ts";
```

Inside `createContext` after session validation:

```ts
const accessWindow = session ? await getAccessWindowForUser(db, session.userId) : undefined;
return { db, userId: session?.userId ?? null, timezone, appVersion, assetsVersion, accessWindow };
```

- [ ] **Step 5: Run tests**

```bash
pnpm vitest packages/server/src/billing/access-window-repository.test.ts packages/server/src/trpc.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/billing/access-window-repository.ts packages/server/src/billing/access-window-repository.test.ts packages/server/src/index.ts
git commit -m "feat: resolve billing access per request"
```

## Task 7: Gate Activity And Export Endpoints First

**Files:**
- Modify: `packages/server/src/routers/activity.ts`
- Modify: `packages/server/src/repositories/activity-repository.ts`
- Modify: `packages/server/src/routes/export.ts`
- Test: `packages/server/src/routers/activity.test.ts`
- Test: `packages/server/src/routes/export.test.ts`

- [ ] **Step 1: Add failing activity list/detail tests**

Extend `packages/server/src/routers/activity.test.ts` with a limited `accessWindow` caller:

```ts
const limitedAccessWindow = {
  kind: "limited" as const,
  paid: false as const,
  reason: "free_signup_week" as const,
  startDate: "2026-04-10",
  endDateExclusive: "2026-04-17",
};
```

Add assertions that list SQL contains both window bounds and `byId` returns `NOT_FOUND` when repository returns null because the activity is outside the allowed window.

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm vitest packages/server/src/routers/activity.test.ts
```

Expected: FAIL because activity repository ignores `ctx.accessWindow`.

- [ ] **Step 3: Pass access window into repository**

In `packages/server/src/routers/activity.ts`, update every `new ActivityRepository`, `new StrengthRepository`, and `new PowerRepository` that backs activity reads to pass `ctx.accessWindow`.

Example:

```ts
const repo = new ActivityRepository(ctx.db, ctx.userId, ctx.timezone, ctx.accessWindow);
```

- [ ] **Step 4: Apply predicates in ActivityRepository**

Modify list query:

```ts
${this.timestampAccessPredicate(sql`a.started_at`)}
```

Modify `findById()` query:

```ts
${this.timestampAccessPredicate(sql`a.started_at`)}
```

Modify stream and zone methods by joining/checking the parent activity:

```sql
AND EXISTS (
  SELECT 1
  FROM fitness.v_activity a
  WHERE a.id = ${activityId}
    AND a.user_id = ${this.userId}
    ${this.timestampAccessPredicate(sql`a.started_at`)}
)
```

- [ ] **Step 5: Add failing export test**

Extend `packages/server/src/routes/export.test.ts` so an unpaid access window passed into export generation filters every table query to the signup-week window. The test should fail until the export route resolves and applies access windows.

- [ ] **Step 6: Implement export gating**

In `packages/server/src/routes/export.ts`, resolve the authenticated user access window and pass it into export query helpers. Add date/timestamp predicates per exported table:

- activity: `started_at`
- sleep sessions: `started_at`
- body measurement: `recorded_at`
- nutrition daily: `date`
- food entry: `date`
- daily metrics: `date`
- strength workout: `started_at`
- lab/health events: `recorded_at` or `start_date`
- metric stream: `recorded_at`

- [ ] **Step 7: Run tests**

```bash
pnpm vitest packages/server/src/routers/activity.test.ts packages/server/src/routes/export.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/routers/activity.ts packages/server/src/repositories/activity-repository.ts packages/server/src/routers/activity.test.ts packages/server/src/routes/export.ts packages/server/src/routes/export.test.ts
git commit -m "feat: gate activity and export reads"
```

## Task 8: Gate Remaining Read Endpoints

**Files:**
- Modify: all read routers/repositories under `packages/server/src/routers/` and `packages/server/src/repositories/` that query user health data.
- Test: colocated `*.test.ts` and relevant `*.integration.test.ts`.

- [ ] **Step 1: Generate the read endpoint inventory**

Run:

```bash
rg -n "protectedProcedure|cachedProtectedQuery|\\.query\\(" packages/server/src/routers -g '*.ts'
```

Write the resulting router/procedure inventory into `.context/stripe-read-gating-inventory.md` with these columns:

```md
| Procedure | Date field | Gate type | Test file |
| --- | --- | --- | --- |
```

This `.context` file is a temporary execution checklist and is not committed.

- [ ] **Step 2: Add failing tests by endpoint group**

For each group below, add at least one test that proves limited users cannot read outside `[startDate, endDateExclusive)`. Use existing router tests when present and add tests next to source when missing:

- daily/body/sleep/nutrition/food/calendar/life-events/journal/breathwork;
- training/power/pmc/recovery/strength/cycling-advanced/hiking/running/intervals/efficiency;
- body-analytics/nutrition-analytics/stress/trends/monthly-report/weekly-report/health-report;
- insights/correlation/predictions/anomaly-detection/healthspan/menstrual-cycle/supplements.

Expected failure before implementation: generated SQL lacks the billing access predicate or detail lookup returns data outside the signup week.

- [ ] **Step 3: Apply access predicates**

For every repository extending `BaseRepository`, pass `ctx.accessWindow` from the router constructor and add:

```ts
${this.dateAccessPredicate(sql`table_alias.date`)}
```

or:

```ts
${this.timestampAccessPredicate(sql`table_alias.recorded_at`)}
```

For raw router SQL without a repository, import a small helper from `BaseRepository` is not possible; instead create a local `billingAccessPredicate(accessWindow, column, "date" | "timestamp")` helper in `packages/server/src/billing/sql.ts` and test it.

- [ ] **Step 4: Run endpoint-group tests after each group**

Use the exact changed test file for each group, for example:

```bash
pnpm vitest packages/server/src/routers/daily-metrics.test.ts
pnpm vitest packages/server/src/routers/recovery.test.ts
pnpm vitest packages/server/src/routers/trends.test.ts
```

Expected: each group passes before moving to the next group.

- [ ] **Step 5: Run broader server router tests**

```bash
pnpm vitest packages/server/src/routers
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/routers packages/server/src/repositories packages/server/src/billing/sql.ts packages/server/src/billing/sql.test.ts
git commit -m "feat: gate health data reads"
```

## Task 9: Web Settings Billing Panel

**Files:**
- Create: `packages/web/src/components/BillingPanel.tsx`
- Create: `packages/web/src/components/BillingPanel.test.tsx`
- Create: `packages/web/src/components/BillingPanel.stories.tsx`
- Modify: `packages/web/src/pages/SettingsPage.tsx`

- [ ] **Step 1: Write failing panel test**

Create `packages/web/src/components/BillingPanel.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BillingPanel } from "./BillingPanel.tsx";

describe("BillingPanel", () => {
  it("shows signup-week access for unpaid users and starts checkout", async () => {
    const createCheckoutSession = vi.fn(async () => ({ url: "https://checkout.stripe.test" }));
    render(
      <BillingPanel
        status={{
          hasFullAccess: false,
          access: {
            kind: "limited",
            paid: false,
            reason: "free_signup_week",
            startDate: "2026-04-10",
            endDateExclusive: "2026-04-17",
          },
          stripeSubscriptionStatus: null,
          canManageBilling: false,
        }}
        createCheckoutSession={createCheckoutSession}
        createPortalSession={vi.fn()}
      />,
    );

    expect(screen.getByText("Signup week access")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Subscribe" }));
    expect(createCheckoutSession).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest packages/web/src/components/BillingPanel.test.tsx
```

Expected: FAIL because component does not exist.

- [ ] **Step 3: Implement panel and stories**

Create `BillingPanel.tsx` with props matching the test. Use concise layman-readable text:

- paid: `Full access`
- unpaid: `Signup week access`
- button: `Subscribe`
- portal button: `Manage Billing`

Create stories for paid, unpaid, loading, and error states in `BillingPanel.stories.tsx`.

- [ ] **Step 4: Wire into SettingsPage**

In `SettingsPage`, query `trpc.billing.status.useQuery()` and add:

```tsx
<PageSection title="Billing" subtitle="Manage subscription access">
  <BillingPanel
    status={billingStatus.data}
    isLoading={billingStatus.isLoading}
    error={billingStatus.error?.message}
    createCheckoutSession={async () => checkoutMutation.mutateAsync()}
    createPortalSession={async () => portalMutation.mutateAsync()}
  />
</PageSection>
```

Use `window.location.href = result.url` after mutations return.

- [ ] **Step 5: Run tests**

```bash
pnpm vitest packages/web/src/components/BillingPanel.test.tsx
cd packages/web && pnpm tsc --noEmit
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/BillingPanel.tsx packages/web/src/components/BillingPanel.test.tsx packages/web/src/components/BillingPanel.stories.tsx packages/web/src/pages/SettingsPage.tsx
git commit -m "feat: add web billing settings"
```

## Task 10: Mobile Settings Billing Section

**Files:**
- Modify: `packages/mobile/app/settings.tsx`
- Modify: `packages/mobile/app/settings.test.tsx`
- Modify or create: `packages/mobile/app/settings.stories.tsx`

- [ ] **Step 1: Write failing mobile settings test**

Extend `packages/mobile/app/settings.test.tsx`. Near `mockProvidersData`, add:

```ts
let mockBillingStatusData: {
  hasFullAccess: boolean;
  access:
    | { kind: "full"; paid: true; reason: "paid_grant" | "stripe_subscription" }
    | {
        kind: "limited";
        paid: false;
        reason: "free_signup_week";
        startDate: string;
        endDateExclusive: string;
      };
  stripeSubscriptionStatus: string | null;
  canManageBilling: boolean;
} = {
  hasFullAccess: true,
  access: { kind: "full", paid: true, reason: "paid_grant" },
  stripeSubscriptionStatus: null,
  canManageBilling: false,
};
```

In the existing `vi.mock("../lib/trpc", ...)` object, add:

```ts
billing: {
  status: {
    useQuery: () => ({ data: mockBillingStatusData, isLoading: false, error: null }),
  },
  createCheckoutSession: {
    useMutation: () => ({ mutateAsync: vi.fn(async () => ({ url: "https://checkout.stripe.test" })), isPending: false }),
  },
  createPortalSession: {
    useMutation: () => ({ mutateAsync: vi.fn(async () => ({ url: "https://billing.stripe.test" })), isPending: false }),
  },
},
```

Then add the test:

```tsx
it("shows signup-week billing access and subscribe action", async () => {
  mockBillingStatusData = {
    hasFullAccess: false,
    access: {
      kind: "limited",
      paid: false,
      reason: "free_signup_week",
      startDate: "2026-04-10",
      endDateExclusive: "2026-04-17",
    },
    stripeSubscriptionStatus: null,
    canManageBilling: false,
  };

  render(<SettingsScreen />);

  expect(await screen.findByText("Billing")).toBeTruthy();
  expect(screen.getByText("Signup week access")).toBeTruthy();
  expect(screen.getByText("Subscribe")).toBeTruthy();
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest packages/mobile/app/settings.test.tsx --project mobile
```

Expected: FAIL because billing UI is not present.

- [ ] **Step 3: Implement mobile billing section**

In `settings.tsx`, add:

```ts
import * as WebBrowser from "expo-web-browser";
```

Add queries/mutations:

```ts
const billingStatus = trpc.billing.status.useQuery();
const checkoutMutation = trpc.billing.createCheckoutSession.useMutation();
const portalMutation = trpc.billing.createPortalSession.useMutation();
```

Add handlers:

```ts
async function openBillingUrl(getUrl: () => Promise<{ url: string }>) {
  try {
    const result = await getUrl();
    await WebBrowser.openBrowserAsync(result.url);
  } catch (error: unknown) {
    captureException(error, { context: "billing-open-url" });
    Alert.alert("Billing Error", error instanceof Error ? error.message : "Unable to open billing.");
  }
}
```

Render a `Billing` section before `Data Export` with `Signup week access`, `Full access`, `Subscribe`, and `Manage Billing` text matching web.

- [ ] **Step 4: Update mobile story**

Update `packages/mobile/app/settings.stories.tsx` mock handlers for:

```ts
[["billing", "status"], { type: "query" }]
[["billing", "createCheckoutSession"], { type: "mutation" }]
[["billing", "createPortalSession"], { type: "mutation" }]
```

- [ ] **Step 5: Run tests**

```bash
pnpm vitest packages/mobile/app/settings.test.tsx --project mobile
cd packages/mobile && pnpm tsc --noEmit
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/mobile/app/settings.tsx packages/mobile/app/settings.test.tsx packages/mobile/app/settings.stories.tsx
git commit -m "feat: add mobile billing settings"
```

## Task 11: Documentation, Secrets, And Final Verification

**Files:**
- Create: `docs/stripe-billing.md`
- Modify: `docs/README.md`
- Modify: `packages/server/README.md`
- Verify: Infisical project secrets outside git.

- [ ] **Step 1: Document setup**

Create `docs/stripe-billing.md`:

```md
# Stripe Billing

Dofek uses Stripe Checkout for subscription purchase and Stripe Customer Portal for billing management. The server stores local entitlement state in `fitness.user_billing` and updates it from verified Stripe webhook events.

Required server environment variables:

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_ID`
- `APP_BASE_URL`

Webhook endpoint:

- `POST /api/webhooks/stripe`

Required Stripe events:

- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`

Existing accounts are granted full access through `paid_grant_reason = 'existing_account'`.
New unpaid accounts can read only signup day through signup day plus six calendar days. Sync and import remain unrestricted.
```

- [ ] **Step 2: Link docs**

Add `docs/stripe-billing.md` to `docs/README.md` and mention billing env vars in `packages/server/README.md`.

- [ ] **Step 3: Verify Infisical secrets**

Run the project’s Infisical command for each deployed environment and confirm all required keys exist. If any key is missing, create it before merge:

```bash
infisical secrets get STRIPE_SECRET_KEY --env=prod
infisical secrets get STRIPE_WEBHOOK_SECRET --env=prod
infisical secrets get STRIPE_PRICE_ID --env=prod
infisical secrets get APP_BASE_URL --env=prod
```

Expected: each command returns a configured value.

- [ ] **Step 4: Run full pre-push checks**

Start dependencies:

```bash
docker compose up -d db redis
docker compose ps db redis
```

Run:

```bash
pnpm lint
pnpm test:changed
pnpm tsc --noEmit
cd packages/server && pnpm tsc --noEmit
cd packages/web && pnpm tsc --noEmit
```

Expected: all exit 0.

- [ ] **Step 5: Commit and push**

```bash
git add docs/stripe-billing.md docs/README.md packages/server/README.md
git commit -m "docs: document stripe billing setup"
git push
```

## Self-Review Checklist

- Spec coverage: Tasks cover schema, existing-user paid grants, Stripe checkout, portal, webhooks, server-side read gating, web UI, mobile UI, docs, secrets, and verification.
- Ambiguity scan: Every task names concrete files, commands, expected failures, and expected passes.
- Type consistency: `AccessWindow`, `resolveAccessWindow`, `BillingRepository`, `billingRouter`, and Stripe config names are consistent across tasks.
