import { describe, expect, it } from "vitest";
import {
  buildMergedEnvironment,
  parseInfisicalSecretsJson,
} from "./sync-dokploy-env-from-infisical-lib.ts";

describe("parseInfisicalSecretsJson", () => {
  it("parses key/value pairs from Infisical JSON output", () => {
    const secrets = parseInfisicalSecretsJson(
      JSON.stringify([
        { secretKey: "SLACK_CLIENT_ID", secretValue: "old-client-id" },
        { secretKey: "SLACK_CLIENT_SECRET", secretValue: "old-client-secret" },
      ]),
    );

    expect(secrets.get("SLACK_CLIENT_ID")).toBe("old-client-id");
    expect(secrets.get("SLACK_CLIENT_SECRET")).toBe("old-client-secret");
  });
});

describe("buildMergedEnvironment", () => {
  it("updates values for keys that already exist in the app env", () => {
    const merged = buildMergedEnvironment({
      existingEnvironmentText: [
        "DATABASE_URL=postgres://example",
        "SLACK_CLIENT_ID=old-client-id",
        "SLACK_CLIENT_SECRET=old-client-secret",
      ].join("\n"),
      infisicalSecrets: new Map([
        ["SLACK_CLIENT_ID", "new-client-id"],
        ["SLACK_CLIENT_SECRET", "new-client-secret"],
        ["CLOUDFLARE_API_TOKEN", "cloudflare-token"],
      ]),
      keysToSync: ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET"],
    });

    expect(merged.changed).toBe(true);
    expect(merged.updatedKeys).toEqual(["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET"]);
    expect(merged.addedKeys).toEqual([]);
    expect(merged.environmentText).toContain("SLACK_CLIENT_ID=new-client-id");
    expect(merged.environmentText).toContain("SLACK_CLIENT_SECRET=new-client-secret");
    expect(merged.environmentText).not.toContain("CLOUDFLARE_API_TOKEN");
  });

  it("adds missing keys when requested", () => {
    const merged = buildMergedEnvironment({
      existingEnvironmentText: "DATABASE_URL=postgres://example\n",
      infisicalSecrets: new Map([["SLACK_BOT_TOKEN", "xoxb-test"]]),
      keysToSync: ["SLACK_BOT_TOKEN"],
    });

    expect(merged.changed).toBe(true);
    expect(merged.updatedKeys).toEqual([]);
    expect(merged.addedKeys).toEqual(["SLACK_BOT_TOKEN"]);
    expect(merged.environmentText).toContain("SLACK_BOT_TOKEN=xoxb-test");
  });

  it("does not report changes when target values already match", () => {
    const merged = buildMergedEnvironment({
      existingEnvironmentText: "SLACK_APP_TOKEN=xapp-test\n",
      infisicalSecrets: new Map([["SLACK_APP_TOKEN", "xapp-test"]]),
      keysToSync: ["SLACK_APP_TOKEN"],
    });

    expect(merged.changed).toBe(false);
    expect(merged.updatedKeys).toEqual([]);
    expect(merged.addedKeys).toEqual([]);
  });

  it("throws when a managed key is missing from Infisical and failOnMissing is true", () => {
    expect(() =>
      buildMergedEnvironment({
        existingEnvironmentText: "DATABASE_URL=postgres://example\n",
        infisicalSecrets: new Map([["SLACK_CLIENT_ID", "client-id"]]),
        keysToSync: ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET"],
        failOnMissing: true,
      }),
    ).toThrow("Missing managed keys in Infisical: SLACK_CLIENT_SECRET");
  });

  it("throws when managed keys include protected destination keys", () => {
    expect(() =>
      buildMergedEnvironment({
        existingEnvironmentText: "DATABASE_URL=postgres://example\n",
        infisicalSecrets: new Map([["DATABASE_URL", "postgres://wrong-target"]]),
        keysToSync: ["DATABASE_URL"],
        protectedDestinationKeys: ["DATABASE_URL", "OTEL_*"],
      }),
    ).toThrow('Refusing to manage protected destination key "DATABASE_URL"');
  });

  it("quotes values containing newlines", () => {
    const pemValue = "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----";
    const merged = buildMergedEnvironment({
      existingEnvironmentText: "DATABASE_URL=postgres://example\n",
      infisicalSecrets: new Map([["PEM_KEY", pemValue]]),
      keysToSync: ["PEM_KEY"],
    });

    expect(merged.changed).toBe(true);
    expect(merged.addedKeys).toEqual(["PEM_KEY"]);
    expect(merged.environmentText).toContain('PEM_KEY="-----BEGIN RSA PRIVATE KEY-----');
    expect(merged.environmentText).not.toContain("PEM_KEY=-----BEGIN");
  });

  it("supports wildcard protected key patterns", () => {
    expect(() =>
      buildMergedEnvironment({
        existingEnvironmentText: "OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318\n",
        infisicalSecrets: new Map([["OTEL_EXPORTER_OTLP_ENDPOINT", "https://example.invalid"]]),
        keysToSync: ["OTEL_EXPORTER_OTLP_ENDPOINT"],
        protectedDestinationKeys: ["OTEL_*"],
      }),
    ).toThrow('Refusing to manage protected destination key "OTEL_EXPORTER_OTLP_ENDPOINT"');
  });
});
