import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { failOnUnhandledExternalRequest } from "../test/msw.ts";
import { ZohoDeskClient } from "../zoho-desk.ts";
import {
  type AccountErasureProcessorProgress,
  eraseAccountProcessors,
  verifyAccountProcessors,
} from "./processor-erasure.ts";
import type { AccountErasureRemoteSnapshot } from "./remote-snapshot.ts";

const snapshot: AccountErasureRemoteSnapshot = {
  appleCredentials: [],
  authIdentities: [],
  externalEffects: [
    {
      contactEmail: "person@example.test",
      externalId: "1994",
      resourceType: "ticket",
      system: "zoho_desk",
    },
  ],
  localIdentifiers: {
    activityIds: [],
    exportObjects: [],
    fileUploads: [],
    processingOperationIds: [],
    sessionIds: [],
    sleepSessionIds: [],
    userId: "20000000-0000-4000-8000-000000001994",
  },
  posthogDistinctId: "20000000-0000-4000-8000-000000001994",
  processorEmails: ["person@example.test", "other+tag@example.test"],
  providerConnections: [],
  slackInstallations: [],
  stripe: null,
  webhooks: [],
};

const config = {
  brevoApiKey: "brevo-contacts-key",
  posthogApiHost: "https://us.posthog.test",
  posthogPersonalApiKey: "phx_person-key",
  posthogProjectId: "12345",
};

const zohoDesk = new ZohoDeskClient({
  clientId: "zoho-client",
  clientSecret: "zoho-secret",
  dataCenter: "us",
  departmentId: "zoho-department",
  orgId: "zoho-org",
  refreshToken: "zoho-refresh",
});

const server = setupServer();
const zohoDeleteBodySchema = z.object({ ids: z.array(z.string().min(1)) });

function processorProgress(
  knownPosthogPersonUuids: readonly string[] = [],
  savePosthogPersonUuids: AccountErasureProcessorProgress["savePosthogPersonUuids"] = () =>
    Promise.resolve(),
): AccountErasureProcessorProgress {
  return {
    knownPosthogPersonUuids,
    savePosthogPersonUuids,
  };
}

describe("account-erasure processors (integration)", () => {
  beforeAll(() => {
    server.listen({ onUnhandledRequest: failOnUnhandledExternalRequest });
  });

  afterEach(() => {
    server.resetHandlers();
  });

  afterAll(() => {
    server.close();
  });

  it("deletes Brevo logs plus recorded and legacy Zoho tickets before queuing PostHog", async () => {
    const brevoEmails: string[] = [];
    const zohoDeletedTicketIds: string[] = [];
    server.use(
      http.delete("https://api.brevo.com/v3/smtp/log/:email", ({ params, request }) => {
        expect(request.headers.get("api-key")).toBe("brevo-contacts-key");
        brevoEmails.push(String(params.email));
        return params.email === "other+tag@example.test"
          ? new HttpResponse(null, { status: 404 })
          : HttpResponse.json({ process_id: 91001 });
      }),
      http.get("https://us.posthog.test/api/projects/12345/persons/", ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("distinct_id")).toBe(snapshot.posthogDistinctId);
        expect(request.headers.get("authorization")).toBe("Bearer phx_person-key");
        return HttpResponse.json({
          count: 1,
          next: null,
          previous: null,
          results: [{ uuid: "30000000-0000-4000-8000-000000001994" }],
        });
      }),
      http.post(
        "https://us.posthog.test/api/projects/12345/persons/bulk_delete/",
        async ({ request }) => {
          expect(await request.json()).toEqual({
            delete_events: true,
            delete_recordings: true,
            distinct_ids: [snapshot.posthogDistinctId],
            keep_person: false,
          });
          return HttpResponse.json(
            {
              deletion_errors: [],
              events_queued_for_deletion: true,
              persons_deleted: 1,
              persons_found: 1,
              recordings_queued_for_deletion: true,
            },
            { status: 202 },
          );
        },
      ),
      http.post("https://accounts.zoho.com/oauth/v2/token", () =>
        HttpResponse.json({
          access_token: "zoho-access",
          expires_in: 3_600,
        }),
      ),
      http.get("https://desk.zoho.com/api/v1/tickets/search", ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("description")).toBe(
          `User ID: ${snapshot.localIdentifiers.userId}`,
        );
        return HttpResponse.json({
          count: 1,
          data: [
            {
              description: `Legacy ticket\n\n---\nUser ID: ${snapshot.localIdentifiers.userId}\nApp version: 0.9.0`,
              id: "1993",
            },
          ],
        });
      }),
      http.get("https://desk.zoho.com/api/v1/tickets/:ticketId", ({ params, request }) => {
        expect(["1993", "1994"]).toContain(params.ticketId);
        expect(request.headers.get("authorization")).toBe("Zoho-oauthtoken zoho-access");
        expect(request.headers.get("orgid")).toBe("zoho-org");
        return HttpResponse.json({ id: params.ticketId });
      }),
      http.post("https://desk.zoho.com/api/v1/tickets/moveToTrash", async ({ request }) => {
        const body = await request.json();
        expect(body).toEqual({
          ticketIds: [expect.stringMatching(/^199[34]$/)],
        });
        return new HttpResponse(null, { status: 204 });
      }),
      http.post("https://desk.zoho.com/api/v1/recycleBin/delete", async ({ request }) => {
        const parsed = zohoDeleteBodySchema.parse(await request.json());
        zohoDeletedTicketIds.push(...parsed.ids);
        return HttpResponse.json({
          results: parsed.ids.map((id) => ({ errors: null, id, success: true })),
        });
      }),
    );

    await expect(
      eraseAccountProcessors(snapshot, config, processorProgress(), { zohoDesk }),
    ).resolves.toEqual({
      brevoProcesses: [
        { email: "person@example.test", processId: 91001 },
        { email: "other+tag@example.test", processId: null },
      ],
      posthogPersonUuids: ["30000000-0000-4000-8000-000000001994"],
      posthogQueued: true,
      zohoTicketIds: ["1994", "1993"],
    });

    expect(brevoEmails).toEqual(["person@example.test", "other+tag@example.test"]);
    expect(zohoDeletedTicketIds).toEqual(["1994", "1993"]);
  });

  it("discovers a legacy Zoho ticket when no provenance row exists", async () => {
    const snapshotWithoutRecordedEffects = {
      ...snapshot,
      externalEffects: [],
      processorEmails: [],
    };
    let deletedTicketId: string | null = null;
    server.use(
      http.get("https://us.posthog.test/api/projects/12345/persons/", () =>
        HttpResponse.json({
          count: 0,
          next: null,
          previous: null,
          results: [],
        }),
      ),
      http.post("https://accounts.zoho.com/oauth/v2/token", () =>
        HttpResponse.json({
          access_token: "zoho-access",
          expires_in: 3_600,
        }),
      ),
      http.get("https://desk.zoho.com/api/v1/tickets/search", () =>
        HttpResponse.json({
          count: 1,
          data: [
            {
              description: `Legacy ticket\n\n---\nUser ID: ${snapshot.localIdentifiers.userId}\nApp version: 0.9.0`,
              id: "1993",
            },
          ],
        }),
      ),
      http.get("https://desk.zoho.com/api/v1/tickets/1993", () =>
        HttpResponse.json({ id: "1993" }),
      ),
      http.post(
        "https://desk.zoho.com/api/v1/tickets/moveToTrash",
        () => new HttpResponse(null, { status: 204 }),
      ),
      http.post("https://desk.zoho.com/api/v1/recycleBin/delete", async ({ request }) => {
        const parsed = zohoDeleteBodySchema.parse(await request.json());
        deletedTicketId = parsed.ids[0] ?? null;
        return HttpResponse.json({
          results: [{ errors: null, id: "1993", success: true }],
        });
      }),
    );

    await expect(
      eraseAccountProcessors(snapshotWithoutRecordedEffects, config, processorProgress(), {
        zohoDesk,
      }),
    ).resolves.toEqual({
      brevoProcesses: [],
      posthogPersonUuids: [],
      posthogQueued: false,
      zohoTicketIds: ["1993"],
    });
    expect(deletedTicketId).toBe("1993");
  });

  it("retains the PostHog person UUID across a hard kill after upstream acceptance", async () => {
    let personLookups = 0;
    let bulkDeleteCalls = 0;
    let persistedPosthogPersonUuids: string[] = [];
    server.use(
      http.get("https://us.posthog.test/api/projects/12345/persons/", () => {
        personLookups += 1;
        return HttpResponse.json({
          count: personLookups === 1 ? 1 : 0,
          next: null,
          previous: null,
          results: personLookups === 1 ? [{ uuid: "30000000-0000-4000-8000-000000001994" }] : [],
        });
      }),
      http.post("https://us.posthog.test/api/projects/12345/persons/bulk_delete/", () => {
        expect(persistedPosthogPersonUuids).toEqual(["30000000-0000-4000-8000-000000001994"]);
        bulkDeleteCalls += 1;
        return HttpResponse.json(
          {
            deletion_errors: [],
            events_queued_for_deletion: bulkDeleteCalls === 1,
            persons_deleted: bulkDeleteCalls === 1 ? 1 : 0,
            persons_found: bulkDeleteCalls === 1 ? 1 : 0,
            recordings_queued_for_deletion: bulkDeleteCalls === 1,
          },
          { status: 202 },
        );
      }),
    );
    const snapshotWithoutBrevoOrZoho = {
      ...snapshot,
      externalEffects: [],
      processorEmails: [],
    };
    const dependencies = {
      zohoDesk: {
        deleteTicket: async () => undefined,
        listTicketIdsByDofekUserId: async () => [],
      },
    };
    const savePosthogPersonUuids = async (personUuids: readonly string[]) => {
      persistedPosthogPersonUuids = [...personUuids];
    };

    await expect(
      eraseAccountProcessors(
        snapshotWithoutBrevoOrZoho,
        config,
        processorProgress(persistedPosthogPersonUuids, savePosthogPersonUuids),
        dependencies,
      ),
    ).resolves.toEqual({
      brevoProcesses: [],
      posthogPersonUuids: ["30000000-0000-4000-8000-000000001994"],
      posthogQueued: true,
      zohoTicketIds: [],
    });
    expect(persistedPosthogPersonUuids).toEqual(["30000000-0000-4000-8000-000000001994"]);

    // Model a hard kill after PostHog accepted deletion but before the returned
    // checkpoint was persisted. Only phase progress survives the retry.
    await expect(
      eraseAccountProcessors(
        snapshotWithoutBrevoOrZoho,
        config,
        processorProgress(persistedPosthogPersonUuids, savePosthogPersonUuids),
        dependencies,
      ),
    ).resolves.toEqual({
      brevoProcesses: [],
      posthogPersonUuids: ["30000000-0000-4000-8000-000000001994"],
      posthogQueued: true,
      zohoTicketIds: [],
    });
    expect(bulkDeleteCalls).toBe(1);
  });

  it("resumes verification from a durable PostHog UUID after a pending attempt", async () => {
    const posthogPersonUuid = "30000000-0000-4000-8000-000000001994";
    let persistedPosthogPersonUuids: string[] = [];
    let personLookups = 0;
    let deletionStatusLookups = 0;
    server.use(
      http.get("https://us.posthog.test/api/projects/12345/persons/", () => {
        personLookups += 1;
        return HttpResponse.json({
          count: personLookups === 1 ? 1 : 0,
          next: null,
          previous: null,
          results: personLookups === 1 ? [{ uuid: posthogPersonUuid }] : [],
        });
      }),
      http.post("https://us.posthog.test/api/projects/12345/persons/bulk_delete/", () => {
        expect(persistedPosthogPersonUuids).toEqual([posthogPersonUuid]);
        return HttpResponse.json(
          {
            deletion_errors: [],
            events_queued_for_deletion: true,
            persons_deleted: 1,
            persons_found: 1,
            recordings_queued_for_deletion: true,
          },
          { status: 202 },
        );
      }),
      http.get(
        "https://us.posthog.test/api/projects/12345/persons/deletion_status/",
        ({ request }) => {
          deletionStatusLookups += 1;
          expect(new URL(request.url).searchParams.get("person_uuid")).toBe(posthogPersonUuid);
          return HttpResponse.json({
            count: 1,
            next: null,
            previous: null,
            results: [
              {
                person_uuid: posthogPersonUuid,
                status: deletionStatusLookups === 1 ? "pending" : "completed",
              },
            ],
          });
        },
      ),
    );
    const snapshotWithoutBrevoOrZoho = {
      ...snapshot,
      externalEffects: [],
      processorEmails: [],
    };
    const dependencies = {
      zohoDesk: {
        deleteTicket: async () => undefined,
        listTicketIdsByDofekUserId: async () => [],
      },
    };
    const checkpoint = {
      brevoProcesses: [],
      posthogPersonUuids: [],
      posthogQueued: false,
      zohoTicketIds: [],
    };
    const savePosthogPersonUuids = async (personUuids: readonly string[]) => {
      persistedPosthogPersonUuids = [...personUuids];
    };

    await expect(
      verifyAccountProcessors(
        snapshotWithoutBrevoOrZoho,
        checkpoint,
        config,
        processorProgress(persistedPosthogPersonUuids, savePosthogPersonUuids),
        dependencies,
      ),
    ).rejects.toThrow("PostHog deletion is still pending");
    expect(persistedPosthogPersonUuids).toEqual([posthogPersonUuid]);

    await expect(
      verifyAccountProcessors(
        snapshotWithoutBrevoOrZoho,
        checkpoint,
        config,
        processorProgress(persistedPosthogPersonUuids, savePosthogPersonUuids),
        dependencies,
      ),
    ).resolves.toEqual({
      brevoLogsVerified: 0,
      posthogDeletionsCompleted: 1,
      zohoTickets: 0,
    });
    expect(deletionStatusLookups).toBe(2);
  });

  it("verifies idempotent remote absence and completed PostHog event deletion", async () => {
    server.use(
      http.get("https://api.brevo.com/v3/processes/:processId", ({ params }) => {
        expect(params.processId).toBe("91001");
        return HttpResponse.json({
          id: 91001,
          name: "DELETE_SMTP_LOGS",
          status: "completed",
        });
      }),
      http.get("https://api.brevo.com/v3/smtp/emails", ({ request }) => {
        const url = new URL(request.url);
        expect(snapshot.processorEmails).toContain(url.searchParams.get("email"));
        return HttpResponse.json({
          count: 0,
          transactionalEmails: [],
        });
      }),
      http.get("https://desk.zoho.com/api/v1/tickets/search", () =>
        HttpResponse.json({ count: 0, data: [] }),
      ),
      http.get(
        "https://desk.zoho.com/api/v1/tickets/:ticketId",
        () => new HttpResponse(null, { status: 404 }),
      ),
      http.get("https://desk.zoho.com/api/v1/recycleBin", () => HttpResponse.json({ data: [] })),
      http.get("https://us.posthog.test/api/projects/12345/persons/", () =>
        HttpResponse.json({
          count: 0,
          next: null,
          previous: null,
          results: [],
        }),
      ),
      http.get(
        "https://us.posthog.test/api/projects/12345/persons/deletion_status/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("person_uuid")).toBe("30000000-0000-4000-8000-000000001994");
          expect(url.searchParams.get("status")).toBe("all");
          return HttpResponse.json({
            count: 1,
            next: null,
            previous: null,
            results: [
              {
                person_uuid: "30000000-0000-4000-8000-000000001994",
                status: "completed",
              },
            ],
          });
        },
      ),
    );

    await expect(
      verifyAccountProcessors(
        snapshot,
        {
          brevoProcesses: [
            { email: "person@example.test", processId: 91001 },
            { email: "other+tag@example.test", processId: null },
          ],
          posthogPersonUuids: ["30000000-0000-4000-8000-000000001994"],
          posthogQueued: true,
          zohoTicketIds: ["1994", "1993"],
        },
        config,
        processorProgress(),
        { zohoDesk },
      ),
    ).resolves.toEqual({
      brevoLogsVerified: 2,
      posthogDeletionsCompleted: 1,
      zohoTickets: 2,
    });
  });

  it("fails verification while PostHog deletion is pending", async () => {
    server.use(
      http.get("https://api.brevo.com/v3/processes/:processId", () =>
        HttpResponse.json({
          id: 91001,
          name: "DELETE_SMTP_LOGS",
          status: "completed",
        }),
      ),
      http.get("https://api.brevo.com/v3/smtp/emails", () =>
        HttpResponse.json({
          count: 0,
          transactionalEmails: [],
        }),
      ),
      http.get("https://desk.zoho.com/api/v1/tickets/search", () =>
        HttpResponse.json({ count: 0, data: [] }),
      ),
      http.get(
        "https://desk.zoho.com/api/v1/tickets/:ticketId",
        () => new HttpResponse(null, { status: 404 }),
      ),
      http.get("https://desk.zoho.com/api/v1/recycleBin", () => HttpResponse.json({ data: [] })),
      http.get("https://us.posthog.test/api/projects/12345/persons/", () =>
        HttpResponse.json({
          count: 0,
          next: null,
          previous: null,
          results: [],
        }),
      ),
      http.get("https://us.posthog.test/api/projects/12345/persons/deletion_status/", () =>
        HttpResponse.json({
          count: 1,
          next: null,
          previous: null,
          results: [
            {
              person_uuid: "30000000-0000-4000-8000-000000001994",
              status: "pending",
            },
          ],
        }),
      ),
    );

    await expect(
      verifyAccountProcessors(
        snapshot,
        {
          brevoProcesses: [
            { email: "person@example.test", processId: 91001 },
            { email: "other+tag@example.test", processId: null },
          ],
          posthogPersonUuids: ["30000000-0000-4000-8000-000000001994"],
          posthogQueued: true,
          zohoTicketIds: ["1994"],
        },
        config,
        processorProgress(),
        { zohoDesk },
      ),
    ).rejects.toThrow("PostHog deletion is still pending");
  });

  it("fails when PostHog reports deletion errors", async () => {
    server.use(
      http.delete("https://api.brevo.com/v3/smtp/log/:email", ({ params }) =>
        HttpResponse.json({
          process_id: params.email === "person@example.test" ? 91001 : 91002,
        }),
      ),
      http.post("https://accounts.zoho.com/oauth/v2/token", () =>
        HttpResponse.json({
          access_token: "zoho-access",
          expires_in: 3_600,
        }),
      ),
      http.get("https://desk.zoho.com/api/v1/tickets/search", () =>
        HttpResponse.json({ count: 0, data: [] }),
      ),
      http.get("https://desk.zoho.com/api/v1/tickets/:ticketId", () =>
        HttpResponse.json({ id: "1994" }),
      ),
      http.post(
        "https://desk.zoho.com/api/v1/tickets/moveToTrash",
        () => new HttpResponse(null, { status: 204 }),
      ),
      http.post("https://desk.zoho.com/api/v1/recycleBin/delete", () =>
        HttpResponse.json({
          results: [{ errors: null, id: "1994", success: true }],
        }),
      ),
      http.get("https://us.posthog.test/api/projects/12345/persons/", () =>
        HttpResponse.json({
          count: 1,
          next: null,
          previous: null,
          results: [{ uuid: "30000000-0000-4000-8000-000000001994" }],
        }),
      ),
      http.post("https://us.posthog.test/api/projects/12345/persons/bulk_delete/", () =>
        HttpResponse.json(
          {
            deletion_errors: [{ message: "warehouse unavailable" }],
            events_queued_for_deletion: false,
            persons_deleted: 0,
            persons_found: 1,
            recordings_queued_for_deletion: false,
          },
          { status: 202 },
        ),
      ),
    );

    await expect(
      eraseAccountProcessors(snapshot, config, processorProgress(), { zohoDesk }),
    ).rejects.toThrow("PostHog bulk deletion returned 1 error(s)");
  });
});
