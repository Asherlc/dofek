import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { KayaApiError, KayaClient, KayaInvalidCredentialsError, signInToKaya } from "./client.ts";

const loginResponse = {
  message: "ok",
  token: "kaya-access-token",
  refresh_token: "kaya-refresh-token",
  user: { id: 42 },
};

describe("KayaClient", () => {
  it("authenticates then fetches sessions and ascents with Kaya's lead field", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(loginResponse))
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            sessionsForUser: [
              {
                id: "session-1",
                start_time: "2026-08-01T10:00:00.000Z",
                end_time: "2026-08-01T11:00:00.000Z",
                gym: { id: "gym-1", name: "Kaya Gym" },
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            ascentsForUser: [
              {
                id: "ascent-1",
                session_id: "session-1",
                date: "2026-08-01T10:30:00.000Z",
                attempts: 2,
                ascent_type: { id: "redpoint", name: "Redpoint" },
                climb: {
                  id: "climb-1",
                  name: "Lead Route",
                  lead: true,
                  climb_type: { id: "routes", name: "Routes" },
                  grade: { id: "grade-1", name: "5.11a", climb_type_group: "route" },
                  gym: { id: "gym-1", name: "Kaya Gym" },
                },
              },
            ],
          },
        }),
      );

    await expect(signInToKaya("climber@example.com", "password", fetchFn)).resolves.toEqual({
      accessToken: "kaya-access-token",
      refreshToken: "kaya-refresh-token",
      userId: "42",
    });

    const client = new KayaClient("kaya-access-token", fetchFn);
    await expect(client.listSessions("42")).resolves.toEqual([
      expect.objectContaining({ id: "session-1", gym: { id: "gym-1", name: "Kaya Gym" } }),
    ]);
    await expect(client.listAscents("42")).resolves.toEqual([
      expect.objectContaining({
        id: "ascent-1",
        climb: expect.objectContaining({ lead: true }),
      }),
    ]);

    const [loginUrl, loginInit] = fetchFn.mock.calls[0] ?? [];
    expect(String(loginUrl)).toBe("https://kaya-beta.kayaclimb.com/api/user/login");
    expect(loginInit).toMatchObject({
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://kaya-app.kayaclimb.com",
        referer: "https://kaya-app.kayaclimb.com/",
      },
      body: JSON.stringify({ email: "climber@example.com", password: "password" }),
    });

    const graphQlRequests = fetchFn.mock.calls.slice(1).map(([, init]) => String(init?.body));
    expect(graphQlRequests).toHaveLength(2);
    expect(JSON.parse(graphQlRequests[0] ?? "")).toMatchObject({
      variables: { user_id: "42", offset: 0, count: 100 },
    });
    expect(graphQlRequests[1]).toContain("lead");
    expect(fetchFn.mock.calls[1]?.[1]?.headers).toMatchObject({
      authorization: "Bearer kaya-access-token",
    });
  });

  it("rejects malformed ascent lead values at the API boundary", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          ascentsForUser: [
            {
              id: "ascent-1",
              session_id: "session-1",
              date: "2026-08-01T10:30:00.000Z",
              attempts: 1,
              ascent_type: { id: "flash", name: "Flash" },
              climb: {
                id: "climb-1",
                name: "Route",
                lead: "yes",
                climb_type: { id: "routes", name: "Routes" },
                grade: { id: "grade-1", name: "5.10a", climb_type_group: "route" },
                gym: { id: "gym-1", name: "Kaya Gym" },
              },
            },
          ],
        },
      }),
    );

    await expect(new KayaClient("token", fetchFn).listAscents("42")).rejects.toThrow();
  });

  it("reports invalid credentials for rejected or malformed login responses", async () => {
    await expect(
      signInToKaya(
        "climber@example.com",
        "password",
        vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 })),
      ),
    ).rejects.toBeInstanceOf(KayaInvalidCredentialsError);

    await expect(
      signInToKaya(
        "climber@example.com",
        "password",
        vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ message: "no" })),
      ),
    ).rejects.toBeInstanceOf(KayaInvalidCredentialsError);
  });

  it("preserves credential error metadata", () => {
    const cause = new Error("network");
    const error = new KayaInvalidCredentialsError({ cause });

    expect(error).toMatchObject({
      name: "KayaInvalidCredentialsError",
      message: "Kaya rejected the email or password",
      cause,
    });
  });

  it("rejects Kaya API status and GraphQL errors", async () => {
    await expect(
      new KayaClient(
        "token",
        vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 })),
      ).listSessions("42"),
    ).rejects.toMatchObject<KayaApiError>({ status: 503 });

    await expect(
      new KayaClient(
        "token",
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(jsonResponse({ errors: [{ message: "session not authorized" }] })),
      ).listSessions("42"),
    ).rejects.toThrow("session not authorized");
  });

  it("validates GraphQL error messages and accepts an empty data envelope", async () => {
    await expect(
      new KayaClient(
        "token",
        vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ errors: [{}] })),
      ).listSessions("42"),
    ).rejects.toBeInstanceOf(ZodError);

    await expect(
      new KayaClient(
        "token",
        vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({})),
      ).listSessions("42"),
    ).resolves.toEqual([]);
  });

  it("paginates after a full page and requests the next offset", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            sessionsForUser: Array.from({ length: 100 }, (_, index) => session(`session-${index}`)),
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: { sessionsForUser: [session("session-100")] } }));

    await expect(new KayaClient("token", fetchFn).listSessions("42")).resolves.toHaveLength(101);
    expect(fetchFn.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).variables)).toEqual([
      { user_id: "42", offset: 0, count: 100 },
      { user_id: "42", offset: 100, count: 100 },
    ]);
  });
});

function session(id: string) {
  return {
    id,
    start_time: "2026-08-01T10:00:00.000Z",
    end_time: "2026-08-01T11:00:00.000Z",
    gym: { id: "gym-1", name: "Kaya Gym" },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
