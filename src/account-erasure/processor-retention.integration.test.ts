import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createIntegrationMswFixture } from "../test/early-msw-lifecycle.ts";
import { failOnUnhandledExternalRequest } from "../test/msw.ts";
import { verifyProcessorRetentionPolicies } from "./processor-retention.ts";

const config = {
  axiomApiToken: "axiom-token",
  axiomDataset: "dofek-logs",
  axiomOrgId: "axiom-org",
  sentryApiHost: "https://us.sentry.test",
  sentryAuthToken: "sentry-token",
  sentryOrg: "east-bay-software",
};

const server = createIntegrationMswFixture(
  http.get("https://api.axiom.co/v2/datasets/dofek-traces", ({ request }) => {
    expect(request.headers.get("authorization")).toBe("Bearer axiom-token");
    expect(request.headers.get("x-axiom-org-id")).toBe("axiom-org");
    return HttpResponse.json({
      id: "dofek-traces",
      name: "dofek-traces",
      retentionDays: 29,
      useRetentionPeriod: true,
    });
  }),
);

describe("account-erasure processor retention (integration)", () => {
  beforeAll(() => {
    server.activate({ onUnhandledRequest: failOnUnhandledExternalRequest });
  });

  afterEach(() => {
    server.resetHandlers();
  });

  afterAll(() => {
    server.deactivate();
  });

  it("verifies processor retention with a one-day margin before the public deadline", async () => {
    server.use(
      http.get("https://api.axiom.co/v2/datasets/dofek-logs", ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer axiom-token");
        expect(request.headers.get("x-axiom-org-id")).toBe("axiom-org");
        return HttpResponse.json({
          id: "dofek-logs",
          name: "dofek-logs",
          retentionDays: 29,
          useRetentionPeriod: true,
        });
      }),
      http.get("https://us.sentry.test/api/0/organizations/east-bay-software/", ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer sentry-token");
        expect(new URL(request.url).searchParams.get("detailed")).toBe("1");
        return HttpResponse.json({
          dataRetention: 29,
          slug: "east-bay-software",
        });
      }),
    );

    await expect(verifyProcessorRetentionPolicies(config)).resolves.toEqual({
      axiomRetentionDays: 29,
      sentryRetentionDays: 29,
    });
  });

  it("fails closed when Axiom custom retention is inactive", async () => {
    server.use(
      http.get("https://api.axiom.co/v2/datasets/dofek-logs", () =>
        HttpResponse.json({
          id: "dofek-logs",
          name: "dofek-logs",
          retentionDays: 30,
          useRetentionPeriod: false,
        }),
      ),
    );

    await expect(verifyProcessorRetentionPolicies(config)).rejects.toThrow(
      "Axiom dataset retention is not enabled",
    );
  });

  it("fails closed when the trace dataset cannot be verified", async () => {
    server.use(
      http.get("https://api.axiom.co/v2/datasets/dofek-logs", () =>
        HttpResponse.json({ retentionDays: 29, useRetentionPeriod: true }),
      ),
      http.get("https://api.axiom.co/v2/datasets/dofek-traces", () =>
        HttpResponse.json({ message: "Dataset not found" }, { status: 404 }),
      ),
    );

    await expect(verifyProcessorRetentionPolicies(config)).rejects.toThrow(
      "Axiom dataset retention verification failed with status 404 for dofek-traces",
    );
  });

  it("fails with an actionable Sentry scope error", async () => {
    server.use(
      http.get("https://api.axiom.co/v2/datasets/dofek-logs", () =>
        HttpResponse.json({
          id: "dofek-logs",
          name: "dofek-logs",
          retentionDays: 29,
          useRetentionPeriod: true,
        }),
      ),
      http.get("https://us.sentry.test/api/0/organizations/east-bay-software/", () =>
        HttpResponse.json({ detail: "You do not have permission" }, { status: 403 }),
      ),
    );

    await expect(verifyProcessorRetentionPolicies(config)).rejects.toThrow(
      "Sentry organization retention verification requires org:read access",
    );
  });

  it("rejects processor retention without a margin before the public 30-day boundary", async () => {
    server.use(
      http.get("https://api.axiom.co/v2/datasets/dofek-logs", () =>
        HttpResponse.json({
          id: "dofek-logs",
          name: "dofek-logs",
          retentionDays: 30,
          useRetentionPeriod: true,
        }),
      ),
    );

    await expect(verifyProcessorRetentionPolicies(config)).rejects.toThrow(
      "Axiom dataset retention exceeds the 29-day account-erasure boundary",
    );
  });
});
