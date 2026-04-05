import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..");
const dockerComposePath = join(repoRoot, "deploy", "docker-compose.yml");
const ciWorkflowPath = join(repoRoot, ".github", "workflows", "ci.yml");
const caddyfilePath = join(repoRoot, "deploy", "Caddyfile");
const appJsonPath = join(repoRoot, "packages", "mobile", "app.json");

describe("OTA deployment config (expo-open-ota)", () => {
  it("defines the ota service in docker-compose", () => {
    const dockerCompose = readFileSync(dockerComposePath, "utf-8");
    expect(dockerCompose).toContain("ghcr.io/axelmarciano/expo-open-ota:");
    expect(dockerCompose).toContain("STORAGE_MODE=s3");
    expect(dockerCompose).toContain("ota-secrets:");
  });

  it("routes ota subdomain in Caddyfile", () => {
    const caddyfile = readFileSync(caddyfilePath, "utf-8");
    expect(caddyfile).toContain("ota.dofek.asherlc.com");
    expect(caddyfile).toContain("reverse_proxy ota:3000");
  });

  it("uses eoas publish in CI OTA deploy", () => {
    const ciWorkflow = readFileSync(ciWorkflowPath, "utf-8");
    expect(ciWorkflow).toMatch(/eoas.*publish/);
    expect(ciWorkflow).toContain("EXPO_TOKEN");
  });

  it("points mobile app at the expo-open-ota server", () => {
    const appJson = JSON.parse(readFileSync(appJsonPath, "utf-8"));
    expect(appJson.expo.updates.url).toBe("https://ota.dofek.asherlc.com/manifest");
    expect(appJson.expo.updates.requestHeaders).toHaveProperty("expo-channel-name");
  });
});
