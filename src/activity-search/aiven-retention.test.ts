import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { createAivenSearchRetentionVerifier } from "./aiven-retention.ts";

const server = setupServer();
const endpoint = "https://api.aiven.io/v1/project/dofek/service/dofek-opensearch/backups";
const retention = {
  now: new Date("2026-11-30T12:00:00Z"),
  piiScrubbedAt: new Date("2026-11-10T12:00:00Z"),
};

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

it.each([
  ["2026-11-29T12:00:00Z", true],
  ["2026-11-10T12:00:00Z", false],
] as const)(
  "checks the backup recorded at %s against the scrub cutoff",
  async (backupTime, expired) => {
    server.use(
      http.get(endpoint, ({ request }) => {
        expect(request.headers.get("authorization")).toBe("aivenv1 retention-token");
        return HttpResponse.json({ backups: [{ backup_time: backupTime }] });
      }),
    );
    const verify = createAivenSearchRetentionVerifier({
      ACTIVITY_SEARCH_RETENTION_TOKEN: "retention-token",
    });
    if (expired) {
      await expect(verify(retention)).resolves.toEqual({
        backupCount: 1,
        serviceLogsExpired: true,
      });
    } else {
      await expect(verify(retention)).rejects.toThrow(
        "Aiven retains backups from before account scrubbing.",
      );
    }
  },
);

it("requires the four-day service log retention window to have elapsed", async () => {
  server.use(http.get(endpoint, () => HttpResponse.json({ backups: [] })));
  const verify = createAivenSearchRetentionVerifier({
    ACTIVITY_SEARCH_RETENTION_TOKEN: "retention-token",
  });
  await expect(
    verify({
      ...retention,
      now: new Date("2026-11-14T11:59:59Z"),
    }),
  ).rejects.toThrow("Aiven service log retention has not elapsed.");
});
