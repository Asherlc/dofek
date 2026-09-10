import { createServer, type Server } from "node:http";
import {
  DeveloperApiProblemSchema,
  DeveloperClientSecretSchema,
} from "@dofek/auth/developer-clients";
import cookieParser from "cookie-parser";
import * as errorReporting from "dofek/lib/error-reporting";
import { sql } from "drizzle-orm";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { createSession } from "../auth/session.ts";
import { DeveloperClientRepository } from "../repositories/developer-client-repository.ts";
import { createDeveloperClientsRouter } from "./developer-clients.ts";
import { hashSecret } from "./external-write-api-primitives.ts";

const firstOwnerId = "00000000-0000-4000-8000-000000000311";
const secondOwnerId = "00000000-0000-4000-8000-000000000312";

async function listen(app: express.Express): Promise<{ baseUrl: string; server: Server }> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  return { baseUrl: `http://127.0.0.1:${address.port}`, server };
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

describe.sequential("developer client management API", () => {
  let context: TestContext;
  let server: Server;
  let baseUrl: string;
  let firstSessionId: string;
  let secondSessionId: string;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(sql`
      INSERT INTO fitness.user_profile (id, name, email, is_admin)
      VALUES
        (${firstOwnerId}, 'First Owner', 'first-api-owner@example.test', false),
        (${secondOwnerId}, 'Second Owner', 'second-api-owner@example.test', false)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        email = EXCLUDED.email,
        is_admin = EXCLUDED.is_admin
    `);
    firstSessionId = (await createSession(context.db, firstOwnerId)).sessionId;
    secondSessionId = (await createSession(context.db, secondOwnerId)).sessionId;

    const app = express();
    app.set("trust proxy", 1);
    app.use(cookieParser());
    app.use(
      "/api/developer/clients",
      createDeveloperClientsRouter({
        db: context.db,
        repository: new DeveloperClientRepository(context.db),
      }),
    );
    ({ baseUrl, server } = await listen(app));
  }, 120_000);

  afterAll(async () => {
    if (server) await close(server);
    await context?.cleanup();
  });

  async function request(
    path: string,
    options: {
      body?: unknown;
      ip?: string;
      method?: "GET" | "PATCH" | "POST";
      sessionId?: string | null;
    } = {},
  ): Promise<Response> {
    const headers = new Headers({ accept: "application/json" });
    if (options.body !== undefined) headers.set("content-type", "application/json");
    if (options.ip) headers.set("x-forwarded-for", options.ip);
    if (options.sessionId !== null) {
      headers.set("authorization", `Bearer ${options.sessionId ?? firstSessionId}`);
    }
    return fetch(`${baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  }

  const validInput = (name: string, redirectUri = "https://client.example/callback") => ({
    name,
    redirectUris: [redirectUri],
    scopes: ["nutrition:write"],
  });

  it("requires a valid cookie-or-Bearer Dofek session", async () => {
    for (const sessionId of [null, "invalid-session"]) {
      const response = await request("/api/developer/clients", { sessionId });
      expect(response.status).toBe(401);
      expect(DeveloperApiProblemSchema.parse(await response.json())).toMatchObject({
        code: "UNAUTHORIZED",
        message: "Sign in to manage developer integrations.",
      });
    }

    const cookieResponse = await fetch(`${baseUrl}/api/developer/clients`, {
      headers: { cookie: `session=${firstSessionId}` },
    });
    expect(cookieResponse.status).toBe(200);
  });

  it("creates an owner client, returns its raw secret once, and never lists secret material", async () => {
    const createResponse = await request("/api/developer/clients", {
      method: "POST",
      ip: "198.51.100.10",
      body: validInput("Meal importer"),
    });
    expect(createResponse.status).toBe(201);
    const created = DeveloperClientSecretSchema.parse(await createResponse.json());
    expect(created.clientSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.client).toMatchObject({
      name: "Meal importer",
      redirectUris: ["https://client.example/callback"],
      scopes: ["nutrition:write"],
      status: "active",
    });

    const rows = await context.db.execute<{ secret_hash: string }>(sql`
      SELECT secret_hash
      FROM fitness.external_client
      WHERE client_id = ${created.client.clientId}
    `);
    expect(rows).toEqual([{ secret_hash: hashSecret(created.clientSecret) }]);
    expect(JSON.stringify(rows)).not.toContain(created.clientSecret);

    const listResponse = await request("/api/developer/clients");
    const listed = await listResponse.json();
    expect(listed).toContainEqual(expect.objectContaining({ clientId: created.client.clientId }));
    expect(JSON.stringify(listed)).not.toMatch(/secret/i);
  });

  it("supports owner detail, update, rotation, and revocation without leaking existence", async () => {
    const created = DeveloperClientSecretSchema.parse(
      await (
        await request("/api/developer/clients", {
          method: "POST",
          ip: "198.51.100.11",
          body: validInput("Lifecycle client", "https://client.example/original"),
        })
      ).json(),
    );
    const clientId = created.client.clientId;

    const detail = await request(`/api/developer/clients/${clientId}`);
    expect(detail.status).toBe(200);

    const updated = await request(`/api/developer/clients/${clientId}`, {
      method: "PATCH",
      body: {
        name: "Updated lifecycle client",
        redirectUris: ["https://client.example/updated"],
      },
    });
    expect(await updated.json()).toMatchObject({
      name: "Updated lifecycle client",
      redirectUris: ["https://client.example/updated"],
    });

    const rotated = await request(`/api/developer/clients/${clientId}/rotate`, {
      method: "POST",
      ip: "198.51.100.12",
    });
    expect(rotated.status).toBe(200);
    const rotatedBody = DeveloperClientSecretSchema.parse(await rotated.json());
    expect(rotatedBody.clientSecret).not.toBe(created.clientSecret);
    expect(rotatedBody.client.clientId).toBe(clientId);

    const missingPath = "/api/developer/clients/ext_missing";
    const nonOwned = await request(`/api/developer/clients/${clientId}`, {
      sessionId: secondSessionId,
    });
    const missing = await request(missingPath, { sessionId: secondSessionId });
    expect(nonOwned.status).toBe(404);
    const nonOwnedProblem = DeveloperApiProblemSchema.parse(await nonOwned.json());
    const missingProblem = DeveloperApiProblemSchema.parse(await missing.json());
    expect({ ...nonOwnedProblem, requestId: undefined }).toEqual({
      ...missingProblem,
      requestId: undefined,
    });

    const revoked = await request(`/api/developer/clients/${clientId}/revoke`, {
      method: "POST",
    });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ revoked: true });
    const revokedDetail = await request(`/api/developer/clients/${clientId}`);
    expect(await revokedDetail.json()).toMatchObject({ status: "revoked" });
    for (const path of [
      `/api/developer/clients/${clientId}/rotate`,
      `/api/developer/clients/${clientId}/revoke`,
    ]) {
      const response = await request(path, { method: "POST", ip: "198.51.100.13" });
      expect(response.status).toBe(404);
    }
  });

  it.each([
    ["blank name", "203.0.113.1", { ...validInput("Valid"), name: "   " }],
    [
      "duplicate canonical redirects",
      "203.0.113.2",
      {
        ...validInput("Duplicate"),
        redirectUris: ["https://client.example", "https://client.example/"],
      },
    ],
    ["HTTP redirect", "203.0.113.3", validInput("HTTP", "http://client.example/callback")],
    [
      "credentials",
      "203.0.113.4",
      validInput("Credentials", "https://user:pass@client.example/callback"),
    ],
    ["fragment", "203.0.113.5", validInput("Fragment", "https://client.example/callback#secret")],
  ])("returns field-level 422 details for %s", async (_label, ip, body) => {
    const response = await request("/api/developer/clients", {
      method: "POST",
      ip,
      body,
    });
    expect(response.status).toBe(422);
    expect(DeveloperApiProblemSchema.parse(await response.json())).toMatchObject({
      code: "VALIDATION_ERROR",
      details: expect.arrayContaining([expect.objectContaining({ path: expect.any(Array) })]),
    });
  });

  it("rate limits the sixth create and sixth rotation attempt per IP", async () => {
    const createStatuses: number[] = [];
    for (let index = 0; index < 6; index += 1) {
      createStatuses.push(
        (
          await request("/api/developer/clients", {
            method: "POST",
            ip: "192.0.2.50",
            body: validInput(
              `Rate-limited create ${index}`,
              `https://rate${index}.example/callback`,
            ),
          })
        ).status,
      );
    }
    expect(createStatuses).toEqual([201, 201, 201, 201, 201, 429]);

    const created = DeveloperClientSecretSchema.parse(
      await (
        await request("/api/developer/clients", {
          method: "POST",
          ip: "192.0.2.51",
          body: validInput("Rate-limited rotation", "https://rotation.example/callback"),
        })
      ).json(),
    );
    const rotateStatuses: number[] = [];
    for (let index = 0; index < 6; index += 1) {
      rotateStatuses.push(
        (
          await request(`/api/developer/clients/${created.client.clientId}/rotate`, {
            method: "POST",
            ip: "192.0.2.52",
          })
        ).status,
      );
    }
    expect(rotateStatuses).toEqual([200, 200, 200, 200, 200, 429]);
    const limited = await request("/api/developer/clients", {
      method: "POST",
      ip: "192.0.2.50",
      body: validInput("Still limited", "https://still-limited.example/callback"),
    });
    expect(DeveloperApiProblemSchema.parse(await limited.json())).toMatchObject({
      status: 429,
      code: "RATE_LIMITED",
    });
  });

  it("counts rejected authentication attempts toward create and rotation limits", async () => {
    const createIp = "192.0.2.53";
    const rejectedCreate = await request("/api/developer/clients", {
      method: "POST",
      ip: createIp,
      sessionId: "invalid-session",
      body: validInput("Rejected create"),
    });
    expect(rejectedCreate.status).toBe(401);
    for (let index = 0; index < 4; index += 1) {
      const response = await request("/api/developer/clients", {
        method: "POST",
        ip: createIp,
        body: validInput(
          `Counted create ${index}`,
          `https://counted-create-${index}.example/callback`,
        ),
      });
      expect(response.status).toBe(201);
    }
    const limitedCreate = await request("/api/developer/clients", {
      method: "POST",
      ip: createIp,
      body: validInput("Limited counted create", "https://limited-create.example/callback"),
    });
    expect(limitedCreate.status).toBe(429);

    const created = DeveloperClientSecretSchema.parse(
      await (
        await request("/api/developer/clients", {
          method: "POST",
          ip: "192.0.2.54",
          body: validInput("Counted rotation", "https://counted-rotation.example/callback"),
        })
      ).json(),
    );
    const rotatePath = `/api/developer/clients/${created.client.clientId}/rotate`;
    const rotateIp = "192.0.2.55";
    const rejectedRotate = await request(rotatePath, {
      method: "POST",
      ip: rotateIp,
      sessionId: "invalid-session",
    });
    expect(rejectedRotate.status).toBe(401);
    for (let index = 0; index < 4; index += 1) {
      const response = await request(rotatePath, { method: "POST", ip: rotateIp });
      expect(response.status).toBe(200);
    }
    const limitedRotate = await request(rotatePath, { method: "POST", ip: rotateIp });
    expect(limitedRotate.status).toBe(429);
  });

  it("reports unexpected failures and returns a safe 503", async () => {
    const databaseFailure = new Error("database exploded around ext_private_identifier");
    const repository = new DeveloperClientRepository(context.db);
    const failingRepository = new Proxy(repository, {
      get(target, property, receiver) {
        if (property === "listOwned") return async () => Promise.reject(databaseFailure);
        return Reflect.get(target, property, receiver);
      },
    });
    const capture = vi.spyOn(errorReporting, "captureException").mockReturnValue("event-id");
    const app = express();
    app.set("trust proxy", 1);
    app.use(
      "/api/developer/clients",
      createDeveloperClientsRouter({ db: context.db, repository: failingRepository }),
    );
    const failureServer = await listen(app);
    try {
      const response = await fetch(`${failureServer.baseUrl}/api/developer/clients`, {
        headers: { authorization: `Bearer ${firstSessionId}` },
      });
      const body = await response.text();
      expect(response.status).toBe(503);
      expect(body).not.toContain("ext_private_identifier");
      expect(body).not.toContain("database exploded");
      expect(DeveloperApiProblemSchema.parse(JSON.parse(body))).toMatchObject({
        code: "SERVICE_UNAVAILABLE",
      });
      expect(capture).toHaveBeenCalledWith(databaseFailure);
    } finally {
      capture.mockRestore();
      await close(failureServer.server);
    }
  });
});
