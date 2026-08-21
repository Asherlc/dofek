import { describe, expect, it } from "vitest";
import {
  processorRetentionConfigFromEnv,
  verifyProcessorRetentionPolicies,
} from "./processor-retention.ts";

const config = {
  axiomApiToken: "axiom-key",
  axiomDataset: "dofek-logs",
  sentryApiHost: "https://sentry.example.com",
  sentryAuthToken: "sentry-key",
  sentryOrg: "east-bay-software",
};

describe("processorRetentionConfigFromEnv", () => {
  it("loads the required processor retention credentials", () => {
    expect(
      processorRetentionConfigFromEnv({
        AXIOM_API_TOKEN: "axiom-key",
        SENTRY_AUTH_TOKEN: "sentry-key",
        SENTRY_ORG: "east-bay-software",
      }),
    ).toEqual({
      axiomApiToken: "axiom-key",
      axiomDataset: "dofek-logs",
      sentryApiHost: "https://us.sentry.io",
      sentryAuthToken: "sentry-key",
      sentryOrg: "east-bay-software",
    });
  });

  it("rejects whitespace-only credentials before worker startup", () => {
    expect(() =>
      processorRetentionConfigFromEnv({
        AXIOM_API_TOKEN: "axiom-key",
        SENTRY_AUTH_TOKEN: " ",
        SENTRY_ORG: "east-bay-software",
      }),
    ).toThrow("SENTRY_AUTH_TOKEN is required for account erasure");
  });

  it("trims credentials before they are used in outbound requests", () => {
    expect(
      processorRetentionConfigFromEnv({
        AXIOM_API_TOKEN: " axiom-key ",
        AXIOM_LOG_DATASET: " dofek-logs ",
        SENTRY_AUTH_TOKEN: " sentry-key ",
        SENTRY_ORG: " east-bay-software ",
      }),
    ).toMatchObject({
      axiomApiToken: "axiom-key",
      axiomDataset: "dofek-logs",
      sentryAuthToken: "sentry-key",
      sentryOrg: "east-bay-software",
    });
  });

  it("trims optional organization and API-host settings", () => {
    expect(
      processorRetentionConfigFromEnv({
        AXIOM_API_TOKEN: "axiom-key",
        AXIOM_DATASET: "ignored",
        AXIOM_LOG_DATASET: " logs ",
        AXIOM_ORG_ID: " axiom-org ",
        SENTRY_API_HOST: " https://sentry.example.com ",
        SENTRY_AUTH_TOKEN: "sentry-key",
        SENTRY_ORG: "east-bay-software",
      }),
    ).toMatchObject({
      axiomDataset: "logs",
      axiomOrgId: "axiom-org",
      sentryApiHost: "https://sentry.example.com",
    });

    expect(
      processorRetentionConfigFromEnv({
        AXIOM_API_TOKEN: "axiom-key",
        AXIOM_ORG_ID: "   ",
        SENTRY_AUTH_TOKEN: "sentry-key",
        SENTRY_ORG: "east-bay-software",
      }),
    ).not.toHaveProperty("axiomOrgId");
  });
});

describe("verifyProcessorRetentionPolicies", () => {
  it("verifies both processor retention policies and sends scoped credentials", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const fetchFn: typeof globalThis.fetch = async (url, init) => {
      requests.push({ init, url: String(url) });
      if (String(url).includes("axiom.co")) {
        return Response.json({ retentionDays: 29, useRetentionPeriod: true });
      }
      return Response.json({ dataRetention: 29 });
    };

    await expect(
      verifyProcessorRetentionPolicies({ ...config, axiomOrgId: "axiom-org" }, fetchFn),
    ).resolves.toEqual({ axiomRetentionDays: 29, sentryRetentionDays: 29 });

    expect(requests[0]).toMatchObject({
      url: "https://api.axiom.co/v2/datasets/dofek-logs",
      init: {
        headers: {
          Authorization: "Bearer axiom-key",
          "X-Axiom-Org-Id": "axiom-org",
        },
      },
    });
    expect(requests[1]).toMatchObject({
      url: "https://sentry.example.com/api/0/organizations/east-bay-software/?detailed=1",
      init: { headers: { Authorization: "Bearer sentry-key" } },
    });
  });

  it("rejects an Axiom request failure", async () => {
    await expect(
      verifyProcessorRetentionPolicies(config, async () => new Response("failed", { status: 503 })),
    ).rejects.toThrow("Axiom dataset retention verification failed with status 503");
  });

  it("rejects disabled or excessive Axiom retention", async () => {
    await expect(
      verifyProcessorRetentionPolicies(config, async () =>
        Response.json({ retentionDays: 29, useRetentionPeriod: false }),
      ),
    ).rejects.toThrow("Axiom dataset retention is not enabled");

    await expect(
      verifyProcessorRetentionPolicies(config, async () =>
        Response.json({ retentionDays: 30, useRetentionPeriod: true }),
      ),
    ).rejects.toThrow("Axiom dataset retention exceeds");
  });

  it("rejects Sentry permission, request, shape, and retention failures", async () => {
    await expect(
      verifyProcessorRetentionPolicies(config, async (url) =>
        String(url).includes("axiom.co")
          ? Response.json({ retentionDays: 29, useRetentionPeriod: true })
          : new Response("forbidden", { status: 403 }),
      ),
    ).rejects.toThrow("requires org:read access");

    await expect(
      verifyProcessorRetentionPolicies(config, async (url) =>
        String(url).includes("axiom.co")
          ? Response.json({ retentionDays: 29, useRetentionPeriod: true })
          : new Response("failed", { status: 500 }),
      ),
    ).rejects.toThrow("Sentry organization retention verification failed with status 500");

    await expect(
      verifyProcessorRetentionPolicies(config, async (url) =>
        String(url).includes("axiom.co")
          ? Response.json({ retentionDays: 29, useRetentionPeriod: true })
          : Response.json({}),
      ),
    ).rejects.toThrow("does not expose dataRetention");

    await expect(
      verifyProcessorRetentionPolicies(config, async (url) =>
        String(url).includes("axiom.co")
          ? Response.json({ retentionDays: 29, useRetentionPeriod: true })
          : Response.json({ dataRetention: 30 }),
      ),
    ).rejects.toThrow("Sentry event retention exceeds");
  });
});
