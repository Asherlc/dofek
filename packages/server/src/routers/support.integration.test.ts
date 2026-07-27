import { listUserExternalEffects } from "dofek/db/user-external-effect";
import { sql } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { createSession } from "../auth/session.ts";
import { createApp } from "../index.ts";
import { makeMockSensorStore } from "./test-helpers.ts";

const USER_WITH_EMAIL = "00000000-0000-4000-8000-0000000000e1";
const USER_WITHOUT_EMAIL = "00000000-0000-4000-8000-0000000000e2";

const mswServer = setupServer();

function tokenHandler() {
  return http.post("https://accounts.zoho.com/oauth/v2/token", () =>
    HttpResponse.json({ access_token: "access-token", expires_in: 3600 }),
  );
}

describe("support router", () => {
  let server: ReturnType<import("express").Express["listen"]>;
  let baseUrl: string;
  let testCtx: TestContext;

  const sessionCookies: Record<string, string> = {};

  beforeAll(async () => {
    process.env.ZOHO_DESK_CLIENT_ID = "client-id";
    process.env.ZOHO_DESK_CLIENT_SECRET = "client-secret";
    process.env.ZOHO_DESK_REFRESH_TOKEN = "refresh-token";
    process.env.ZOHO_DESK_ORG_ID = "929149487";
    process.env.ZOHO_DESK_DEPARTMENT_ID = "dept-id";

    mswServer.listen({ onUnhandledRequest: "bypass" });
    testCtx = await setupTestDatabase();

    for (const [id, email] of [
      [USER_WITH_EMAIL, "support-user@example.com"],
      [USER_WITHOUT_EMAIL, null],
    ] as const) {
      await testCtx.db.execute(
        sql`INSERT INTO fitness.user_profile (id, name, email)
            VALUES (${id}, 'Support Tester', ${email})
            ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
      );
      await testCtx.db.execute(
        sql`INSERT INTO fitness.user_billing (user_id, paid_grant_reason)
            VALUES (${id}, 'existing_account')
            ON CONFLICT (user_id) DO NOTHING`,
      );
      const session = await createSession(testCtx.db, id);
      sessionCookies[id] = `session=${session.sessionId}`;
    }

    const app = createApp(testCtx.db, makeMockSensorStore());
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        baseUrl = `http://localhost:${port}`;
        resolve();
      });
    });
  }, 120_000);

  afterEach(() => mswServer.resetHandlers());

  afterAll(async () => {
    mswServer.close();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await testCtx?.cleanup();
  });

  async function createTicket(userId: string, input: Record<string, unknown>) {
    const res = await fetch(`${baseUrl}/api/trpc/support.createTicket`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookies[userId] ?? "" },
      body: JSON.stringify(input),
    });
    return { status: res.status, body: await res.json() };
  }

  it("creates a Zoho ticket using the profile email and returns the ticket number", async () => {
    let received: { orgId: string | null; body: unknown } | null = null;
    mswServer.use(
      tokenHandler(),
      http.post("https://desk.zoho.com/api/v1/tickets", async ({ request }) => {
        received = { orgId: request.headers.get("orgId"), body: await request.json() };
        return HttpResponse.json({ id: "555", ticketNumber: "777" });
      }),
    );

    const { body } = await createTicket(USER_WITH_EMAIL, {
      subject: "Garmin sync broken",
      message: "Activities stopped importing yesterday.",
    });

    expect(body.result.data).toEqual({ ticketNumber: "777" });
    expect(received?.orgId).toBe("929149487");
    expect(received?.body).toMatchObject({
      subject: "Garmin sync broken",
      departmentId: "dept-id",
      contact: { email: "support-user@example.com", lastName: "Support Tester" },
    });
    await expect(listUserExternalEffects(testCtx.db, USER_WITH_EMAIL)).resolves.toContainEqual({
      system: "zoho_desk",
      resourceType: "ticket",
      externalId: "555",
      contactEmail: "support-user@example.com",
    });
  });

  it("prefers an explicitly provided reply email over the profile email", async () => {
    let contactEmail: string | undefined;
    mswServer.use(
      tokenHandler(),
      http.post("https://desk.zoho.com/api/v1/tickets", async ({ request }) => {
        const json = z
          .object({ contact: z.object({ email: z.string().optional() }).optional() })
          .parse(await request.json());
        contactEmail = json.contact?.email;
        return HttpResponse.json({ id: "1", ticketNumber: "2" });
      }),
    );

    await createTicket(USER_WITH_EMAIL, {
      subject: "Question",
      message: "Reply to my other address please.",
      email: "alternate@example.com",
    });

    expect(contactEmail).toBe("alternate@example.com");
  });

  it("fails with PRECONDITION_FAILED when no email is available", async () => {
    const { body } = await createTicket(USER_WITHOUT_EMAIL, {
      subject: "No email",
      message: "I have no profile email and gave none.",
    });

    expect(body.error?.data?.code).toBe("PRECONDITION_FAILED");
  });

  it("maps Zoho failures to BAD_GATEWAY", async () => {
    mswServer.use(
      tokenHandler(),
      http.post("https://desk.zoho.com/api/v1/tickets", () =>
        HttpResponse.json({ message: "boom" }, { status: 500 }),
      ),
    );

    const { body } = await createTicket(USER_WITH_EMAIL, {
      subject: "Will fail",
      message: "Zoho is down.",
    });

    expect(body.error?.data?.code).toBe("BAD_GATEWAY");
  });

  it("does not create a Zoho ticket after account erasure is activated", async () => {
    let ticketRequests = 0;
    mswServer.use(
      tokenHandler(),
      http.post("https://desk.zoho.com/api/v1/tickets", () => {
        ticketRequests += 1;
        return HttpResponse.json({ id: "1", ticketNumber: "2" });
      }),
    );
    await testCtx.db.execute(
      sql`INSERT INTO fitness.account_erasure_request (
            user_id,
            user_hash,
            user_hash_key_id,
            write_fence_hash,
            status_token_hash,
            replay_retained_until,
            completion_deadline
          )
          VALUES (
            ${USER_WITH_EMAIL},
            'support-user-hash',
            'test-key',
            encode(public.digest(${USER_WITH_EMAIL}, 'sha256'), 'hex'),
            'support-status-token',
            now() + interval '30 days',
            now() + interval '30 days'
          )`,
    );

    try {
      const { body } = await createTicket(USER_WITH_EMAIL, {
        subject: "Must be rejected",
        message: "This must never reach Zoho.",
      });

      expect(body.error).toBeDefined();
      expect(ticketRequests).toBe(0);
    } finally {
      await testCtx.db.execute(
        sql`DELETE FROM fitness.account_erasure_request
            WHERE user_id = ${USER_WITH_EMAIL}`,
      );
    }
  });

  it("does not recreate Zoho data after account erasure has completed", async () => {
    let ticketRequests = 0;
    mswServer.use(
      tokenHandler(),
      http.post("https://desk.zoho.com/api/v1/tickets", () => {
        ticketRequests += 1;
        return HttpResponse.json({ id: "1", ticketNumber: "2" });
      }),
    );
    await testCtx.db.execute(
      sql`INSERT INTO fitness.account_erasure_request (
            user_id,
            user_hash,
            user_hash_key_id,
            write_fence_hash,
            status_token_hash,
            status,
            replay_retained_until,
            completion_deadline,
            completed_at
          )
          VALUES (
            NULL,
            'completed-support-user-hash',
            'test-key',
            encode(public.digest(${USER_WITH_EMAIL}, 'sha256'), 'hex'),
            'completed-support-status-token',
            'completed',
            now() + interval '30 days',
            now(),
            now()
          )`,
    );

    try {
      const { body } = await createTicket(USER_WITH_EMAIL, {
        subject: "Must remain rejected",
        message: "Completed erasure must permanently fence this user ID.",
      });

      expect(body.error).toBeDefined();
      expect(ticketRequests).toBe(0);
    } finally {
      await testCtx.db.execute(
        sql`DELETE FROM fitness.account_erasure_request
            WHERE write_fence_hash = encode(
              public.digest(${USER_WITH_EMAIL}, 'sha256'),
              'hex'
            )`,
      );
    }
  });
});
