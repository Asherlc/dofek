import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ZohoDeskClient, type ZohoDeskConfig, ZohoDeskError } from "./zoho-desk.ts";

const config: ZohoDeskConfig = {
  clientId: "client-id",
  clientSecret: "client-secret",
  refreshToken: "refresh-token",
  orgId: "929149487",
  departmentId: "dept-id",
  dataCenter: "us",
};

const mswServer = setupServer();

beforeAll(() => mswServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());

describe("ZohoDeskClient", () => {
  it("refreshes the access token and creates a ticket with org + auth headers", async () => {
    let tokenCalls = 0;
    const ticketRequests: Array<{ orgId: string | null; auth: string | null; body: unknown }> = [];

    mswServer.use(
      http.post("https://accounts.zoho.com/oauth/v2/token", () => {
        tokenCalls += 1;
        return HttpResponse.json({ access_token: "access-1", expires_in: 3600 });
      }),
      http.post("https://desk.zoho.com/api/v1/tickets", async ({ request }) => {
        ticketRequests.push({
          orgId: request.headers.get("orgId"),
          auth: request.headers.get("Authorization"),
          body: await request.json(),
        });
        return HttpResponse.json({ id: "100", ticketNumber: "101" });
      }),
    );

    const client = new ZohoDeskClient(config);
    const ticket = await client.createTicket({
      subject: "Cannot sync Garmin",
      description: "My Garmin activities stopped importing.",
      contactEmail: "user@example.com",
      contactName: "Asher",
    });

    expect(ticket).toEqual({ id: "100", ticketNumber: "101" });
    expect(tokenCalls).toBe(1);
    expect(ticketRequests).toHaveLength(1);
    expect(ticketRequests[0]?.orgId).toBe("929149487");
    expect(ticketRequests[0]?.auth).toBe("Zoho-oauthtoken access-1");
    expect(ticketRequests[0]?.body).toMatchObject({
      subject: "Cannot sync Garmin",
      departmentId: "dept-id",
      contact: { email: "user@example.com", lastName: "Asher" },
    });
  });

  it("reuses a cached access token across ticket creations", async () => {
    let tokenCalls = 0;
    mswServer.use(
      http.post("https://accounts.zoho.com/oauth/v2/token", () => {
        tokenCalls += 1;
        return HttpResponse.json({ access_token: "access-1", expires_in: 3600 });
      }),
      http.post("https://desk.zoho.com/api/v1/tickets", () =>
        HttpResponse.json({ id: "1", ticketNumber: "1" }),
      ),
    );

    const client = new ZohoDeskClient(config);
    const ticketInput = {
      subject: "s",
      description: "d",
      contactEmail: "u@example.com",
      contactName: "U",
    };
    await client.createTicket(ticketInput);
    await client.createTicket(ticketInput);

    expect(tokenCalls).toBe(1);
  });

  it("throws ZohoDeskError when ticket creation fails", async () => {
    mswServer.use(
      http.post("https://accounts.zoho.com/oauth/v2/token", () =>
        HttpResponse.json({ access_token: "access-1", expires_in: 3600 }),
      ),
      http.post("https://desk.zoho.com/api/v1/tickets", () =>
        HttpResponse.json({ message: "nope" }, { status: 422 }),
      ),
    );

    const client = new ZohoDeskClient(config);
    await expect(
      client.createTicket({
        subject: "s",
        description: "d",
        contactEmail: "u@example.com",
        contactName: "U",
      }),
    ).rejects.toBeInstanceOf(ZohoDeskError);
  });

  it("finds legacy tickets only when the controlled footer has the exact Dofek user ID", async () => {
    const userId = "10000000-0000-4000-8000-000000001994";
    const otherUserId = "20000000-0000-4000-8000-000000001994";
    mswServer.use(
      http.post("https://accounts.zoho.com/oauth/v2/token", () =>
        HttpResponse.json({ access_token: "access-1", expires_in: 3600 }),
      ),
      http.get("https://desk.zoho.com/api/v1/tickets/search", ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("departmentId")).toBeNull();
        expect(url.searchParams.get("description")).toBe(`User ID: ${userId}`);
        expect(url.searchParams.get("from")).toBe("0");
        expect(url.searchParams.get("limit")).toBe("100");
        return HttpResponse.json({
          count: 3,
          data: [
            {
              description: `Please help\n\n---\nUser ID: ${userId}\nApp version: 1.0.0`,
              id: "98",
            },
            {
              description: `Please investigate User ID: ${userId}\n\n---\nUser ID: ${otherUserId}\nApp version: 1.0.0`,
              id: "99",
            },
            {
              description: null,
              id: "100",
            },
          ],
        });
      }),
    );

    await expect(new ZohoDeskClient(config).listTicketIdsByDofekUserId(userId)).resolves.toEqual([
      "98",
    ]);
  });

  it("moves a ticket to trash and permanently deletes its exact Zoho ID", async () => {
    const operations: string[] = [];
    mswServer.use(
      http.post("https://accounts.zoho.com/oauth/v2/token", () =>
        HttpResponse.json({ access_token: "access-1", expires_in: 3600 }),
      ),
      http.get("https://desk.zoho.com/api/v1/tickets/:ticketId", ({ params, request }) => {
        expect(params.ticketId).toBe("100");
        expect(request.headers.get("orgId")).toBe("929149487");
        expect(request.headers.get("Authorization")).toBe("Zoho-oauthtoken access-1");
        operations.push("active");
        return HttpResponse.json({ id: "100" });
      }),
      http.post("https://desk.zoho.com/api/v1/tickets/moveToTrash", async ({ request }) => {
        expect(await request.json()).toEqual({ ticketIds: ["100"] });
        operations.push("trash");
        return new HttpResponse(null, { status: 204 });
      }),
      http.post("https://desk.zoho.com/api/v1/recycleBin/delete", async ({ request }) => {
        expect(await request.json()).toEqual({ ids: ["100"] });
        operations.push("permanent");
        return HttpResponse.json({
          results: [{ errors: null, id: "100", success: true }],
        });
      }),
    );

    await new ZohoDeskClient(config).deleteTicket("100");

    expect(operations).toEqual(["active", "trash", "permanent"]);
  });

  it("treats a ticket absent from active storage and the recycle bin as deleted", async () => {
    mswServer.use(
      http.post("https://accounts.zoho.com/oauth/v2/token", () =>
        HttpResponse.json({ access_token: "access-1", expires_in: 3600 }),
      ),
      http.get(
        "https://desk.zoho.com/api/v1/tickets/:ticketId",
        () => new HttpResponse(null, { status: 404 }),
      ),
      http.get("https://desk.zoho.com/api/v1/recycleBin", ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("departmentId")).toBeNull();
        expect(url.searchParams.get("from")).toBe("0");
        expect(url.searchParams.get("limit")).toBe("100");
        expect(url.searchParams.get("module")).toBe("tickets");
        return HttpResponse.json({ data: [] });
      }),
    );

    await expect(new ZohoDeskClient(config).deleteTicket("100")).resolves.toBeUndefined();
  });

  it("permanently deletes a ticket left in the recycle bin by an interrupted attempt", async () => {
    mswServer.use(
      http.post("https://accounts.zoho.com/oauth/v2/token", () =>
        HttpResponse.json({ access_token: "access-1", expires_in: 3600 }),
      ),
      http.get(
        "https://desk.zoho.com/api/v1/tickets/:ticketId",
        () => new HttpResponse(null, { status: 404 }),
      ),
      http.get("https://desk.zoho.com/api/v1/recycleBin", () =>
        HttpResponse.json({
          data: [{ id: "100" }],
        }),
      ),
      http.post("https://desk.zoho.com/api/v1/recycleBin/delete", () =>
        HttpResponse.json({
          results: [{ errors: null, id: "100", success: true }],
        }),
      ),
    );

    await expect(new ZohoDeskClient(config).deleteTicket("100")).resolves.toBeUndefined();
  });

  it("fails closed when Zoho does not confirm permanent deletion", async () => {
    mswServer.use(
      http.post("https://accounts.zoho.com/oauth/v2/token", () =>
        HttpResponse.json({ access_token: "access-1", expires_in: 3600 }),
      ),
      http.get("https://desk.zoho.com/api/v1/tickets/:ticketId", () =>
        HttpResponse.json({ id: "100" }),
      ),
      http.post(
        "https://desk.zoho.com/api/v1/tickets/moveToTrash",
        () => new HttpResponse(null, { status: 204 }),
      ),
      http.post("https://desk.zoho.com/api/v1/recycleBin/delete", () =>
        HttpResponse.json({
          results: [{ errors: { errorCode: "FORBIDDEN" }, id: "100", success: false }],
        }),
      ),
    );

    await expect(new ZohoDeskClient(config).deleteTicket("100")).rejects.toThrow(
      "Zoho did not confirm permanent deletion of ticket 100",
    );
  });
});
