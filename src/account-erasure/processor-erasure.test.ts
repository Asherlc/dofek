import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deleteTicket: vi.fn(async () => undefined),
  listTicketIdsByDofekUserId: vi.fn<() => Promise<string[]>>(() => Promise.resolve([])),
  getZohoDeskClient: vi.fn(),
}));

vi.mock("../zoho-desk.ts", () => ({
  getZohoDeskClient: mocks.getZohoDeskClient.mockReturnValue({
    deleteTicket: mocks.deleteTicket,
    listTicketIdsByDofekUserId: mocks.listTicketIdsByDofekUserId,
  }),
}));

import {
  type AccountErasureProcessorProgress,
  accountErasureProcessorConfigFromEnv,
  eraseAccountProcessors,
  verifyAccountProcessors,
} from "./processor-erasure.ts";
import type { AccountErasureRemoteSnapshot } from "./remote-snapshot.ts";

const config = {
  brevoApiKey: "brevo-key",
  posthogApiHost: "https://us.posthog.test",
  posthogPersonalApiKey: "posthog-key",
  posthogProjectId: "12345",
};

const snapshotWithoutZohoEffects: AccountErasureRemoteSnapshot = {
  appleCredentials: [],
  authIdentities: [],
  externalEffects: [],
  localIdentifiers: {
    activityIds: [],
    exportObjects: [],
    fileUploads: [],
    processingOperationIds: [],
    sessionIds: [],
    sleepSessionIds: [],
    userId: "10000000-0000-4000-8000-000000001994",
  },
  posthogDistinctId: "10000000-0000-4000-8000-000000001994",
  processorEmails: [],
  providerConnections: [],
  slackInstallations: [],
  stripe: null,
  webhooks: [],
};

function processorProgress(): AccountErasureProcessorProgress {
  return {
    knownPosthogPersonUuids: [],
    savePosthogPersonUuids: () => Promise.resolve(),
  };
}

describe("accountErasureProcessorConfigFromEnv", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads the required processor deletion credentials", () => {
    expect(
      accountErasureProcessorConfigFromEnv({
        BREVO_API_KEY: "brevo-key",
        POSTHOG_PERSONAL_API_KEY: "posthog-key",
        POSTHOG_PROJECT_ID: "12345",
      }),
    ).toEqual({
      brevoApiKey: "brevo-key",
      posthogApiHost: "https://us.posthog.com",
      posthogPersonalApiKey: "posthog-key",
      posthogProjectId: "12345",
    });
  });

  it("rejects whitespace-only credentials before worker startup", () => {
    expect(() =>
      accountErasureProcessorConfigFromEnv({
        BREVO_API_KEY: " ",
        POSTHOG_PERSONAL_API_KEY: "posthog-key",
        POSTHOG_PROJECT_ID: "12345",
      }),
    ).toThrow("BREVO_API_KEY is required for account erasure");
  });

  it("trims an explicitly configured PostHog API host", () => {
    expect(
      accountErasureProcessorConfigFromEnv({
        BREVO_API_KEY: "brevo-key",
        POSTHOG_API_HOST: " https://eu.posthog.test/ ",
        POSTHOG_PERSONAL_API_KEY: "posthog-key",
        POSTHOG_PROJECT_ID: "12345",
      }),
    ).toEqual({
      brevoApiKey: "brevo-key",
      posthogApiHost: "https://eu.posthog.test/",
      posthogPersonalApiKey: "posthog-key",
      posthogProjectId: "12345",
    });
  });

  it("searches for legacy Zoho tickets when the snapshot has no recorded Zoho effects", async () => {
    const fetchFn: typeof globalThis.fetch = async (input, init) => {
      const requestUrl = new URL(input instanceof Request ? input.url : input.toString());
      if (requestUrl.pathname.endsWith("/persons/")) {
        return Response.json({ next: null, results: [] });
      }
      throw new Error(`Unexpected ${init?.method ?? "GET"} request: ${requestUrl}`);
    };

    await expect(
      eraseAccountProcessors(snapshotWithoutZohoEffects, config, processorProgress(), { fetchFn }),
    ).resolves.toEqual({
      brevoProcesses: [],
      posthogPersonUuids: [],
      posthogQueued: false,
      zohoTicketIds: [],
    });
    expect(mocks.getZohoDeskClient).toHaveBeenCalledOnce();
    expect(mocks.listTicketIdsByDofekUserId).toHaveBeenCalledWith(
      snapshotWithoutZohoEffects.localIdentifiers.userId,
    );
    expect(mocks.deleteTicket).not.toHaveBeenCalled();
  });

  it("repeats legacy Zoho discovery while verifying a snapshot with no recorded effects", async () => {
    const fetchFn: typeof globalThis.fetch = async (input, init) => {
      const requestUrl = new URL(input instanceof Request ? input.url : input.toString());
      if (requestUrl.pathname.endsWith("/persons/")) {
        return Response.json({ next: null, results: [] });
      }
      throw new Error(`Unexpected ${init?.method ?? "GET"} request: ${requestUrl}`);
    };

    await expect(
      verifyAccountProcessors(
        snapshotWithoutZohoEffects,
        {
          brevoProcesses: [],
          posthogPersonUuids: [],
          posthogQueued: false,
          zohoTicketIds: [],
        },
        config,
        processorProgress(),
        { fetchFn },
      ),
    ).resolves.toEqual({
      brevoLogsVerified: 0,
      posthogDeletionsCompleted: 0,
      zohoTickets: 0,
    });
    expect(mocks.getZohoDeskClient).toHaveBeenCalledOnce();
    expect(mocks.listTicketIdsByDofekUserId).toHaveBeenCalledWith(
      snapshotWithoutZohoEffects.localIdentifiers.userId,
    );
  });

  it("deletes Brevo and Zoho records and queues discovered PostHog people", async () => {
    vi.clearAllMocks();
    const personUuid = "90000000-0000-4000-8000-000000001994";
    const snapshot: AccountErasureRemoteSnapshot = {
      ...snapshotWithoutZohoEffects,
      externalEffects: [
        {
          contactEmail: "first@example.com",
          externalId: "ticket-recorded",
          resourceType: "ticket",
          system: "zoho_desk",
        },
      ],
      posthogDistinctId: "distinct-1994",
      processorEmails: ["first@example.com", "first@example.com", "second@example.com"],
    };
    mocks.listTicketIdsByDofekUserId.mockResolvedValue(["ticket-recorded", "ticket-legacy"]);
    const savedPersonUuids: string[][] = [];
    const progress: AccountErasureProcessorProgress = {
      knownPosthogPersonUuids: [],
      savePosthogPersonUuids: async (personUuids) => {
        savedPersonUuids.push([...personUuids]);
      },
    };
    const fetchFn: typeof globalThis.fetch = async (input, init) => {
      const requestUrl = new URL(input instanceof Request ? input.url : input.toString());
      if (requestUrl.hostname === "api.brevo.com" && requestUrl.pathname.includes("first%40")) {
        return Response.json({ process_id: 123 });
      }
      if (requestUrl.hostname === "api.brevo.com" && requestUrl.pathname.includes("second%40")) {
        return new Response(null, { status: 404 });
      }
      if (requestUrl.pathname.endsWith("/persons/")) {
        return Response.json({ next: null, results: [{ uuid: personUuid }] });
      }
      if (requestUrl.pathname.endsWith("/bulk_delete/")) {
        return Response.json(
          {
            deletion_errors: [],
            events_queued_for_deletion: true,
            recordings_queued_for_deletion: true,
          },
          { status: 202 },
        );
      }
      throw new Error(`Unexpected ${init?.method ?? "GET"} request: ${requestUrl}`);
    };

    await expect(eraseAccountProcessors(snapshot, config, progress, { fetchFn })).resolves.toEqual({
      brevoProcesses: [
        { email: "first@example.com", processId: 123 },
        { email: "second@example.com", processId: null },
      ],
      posthogPersonUuids: [personUuid],
      posthogQueued: true,
      zohoTicketIds: ["ticket-recorded", "ticket-legacy"],
    });
    expect(savedPersonUuids).toEqual([[personUuid]]);
    expect(mocks.deleteTicket).toHaveBeenCalledWith("ticket-recorded");
    expect(mocks.deleteTicket).toHaveBeenCalledWith("ticket-legacy");
  });

  it("verifies completed processor deletion and persists newly discovered people", async () => {
    vi.clearAllMocks();
    const personUuid = "90000000-0000-4000-8000-000000001994";
    const snapshot = snapshotWithoutZohoEffects;
    mocks.listTicketIdsByDofekUserId.mockResolvedValue(["ticket-legacy"]);
    let personLookupCount = 0;
    const fetchFn: typeof globalThis.fetch = async (input, init) => {
      const requestUrl = new URL(input instanceof Request ? input.url : input.toString());
      if (
        requestUrl.hostname === "api.brevo.com" &&
        requestUrl.pathname.includes("/processes/123")
      ) {
        return Response.json({ status: "completed" });
      }
      if (requestUrl.hostname === "api.brevo.com" && requestUrl.pathname.endsWith("/smtp/emails")) {
        return Response.json({ count: 0, transactionalEmails: [] });
      }
      if (requestUrl.pathname.endsWith("/persons/")) {
        personLookupCount += 1;
        return Response.json({ next: null, results: [] });
      }
      if (requestUrl.pathname.endsWith("/deletion_status/")) {
        return Response.json({ results: [{ person_uuid: personUuid, status: "completed" }] });
      }
      throw new Error(`Unexpected ${init?.method ?? "GET"} request: ${requestUrl}`);
    };

    await expect(
      verifyAccountProcessors(
        snapshot,
        {
          brevoProcesses: [
            { email: "first@example.com", processId: 123 },
            { email: "second@example.com", processId: null },
          ],
          posthogPersonUuids: [personUuid],
          posthogQueued: true,
          zohoTicketIds: ["ticket-legacy"],
        },
        config,
        {
          knownPosthogPersonUuids: [],
          savePosthogPersonUuids: async () => undefined,
        },
        { fetchFn },
      ),
    ).resolves.toEqual({
      brevoLogsVerified: 2,
      posthogDeletionsCompleted: 1,
      zohoTickets: 1,
    });
    expect(personLookupCount).toBe(2);
    expect(mocks.deleteTicket).toHaveBeenCalledWith("ticket-legacy");
  });

  it("stops processor verification while PostHog deletion is pending", async () => {
    const personUuid = "90000000-0000-4000-8000-000000001994";
    const fetchFn: typeof globalThis.fetch = async (input) => {
      const requestUrl = new URL(input instanceof Request ? input.url : input.toString());
      if (requestUrl.pathname.endsWith("/persons/")) {
        return Response.json({ next: null, results: [] });
      }
      if (requestUrl.pathname.endsWith("/deletion_status/")) {
        return Response.json({ results: [{ person_uuid: personUuid, status: "pending" }] });
      }
      if (requestUrl.hostname === "api.brevo.com" && requestUrl.pathname.endsWith("/smtp/emails")) {
        return Response.json({ count: 0, transactionalEmails: [] });
      }
      throw new Error(`Unexpected request: ${requestUrl}`);
    };

    await expect(
      verifyAccountProcessors(
        snapshotWithoutZohoEffects,
        {
          brevoProcesses: [],
          posthogPersonUuids: [personUuid],
          posthogQueued: true,
          zohoTicketIds: [],
        },
        config,
        processorProgress(),
        { fetchFn },
      ),
    ).rejects.toThrow("PostHog deletion is still pending");
  });
});
