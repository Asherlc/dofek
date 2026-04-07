import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..");
const infraComposePath = join(repoRoot, "deploy", "dokploy", "infra-compose.yml");
const ciWorkflowPath = join(repoRoot, ".github", "workflows", "ci.yml");
const appJsonPath = join(repoRoot, "packages", "mobile", "app.json");

describe("OTA deployment config (expo-open-ota)", () => {
  it("defines the ota service in infra-compose", () => {
    const infraCompose = readFileSync(infraComposePath, "utf-8");
    expect(infraCompose).toContain("ghcr.io/axelmarciano/expo-open-ota:");
    expect(infraCompose).toContain("STORAGE_MODE: s3");
  });

  it("fails the ota healthcheck when the manifest probe fails", () => {
    const infraCompose = readFileSync(infraComposePath, "utf-8");
    expect(infraCompose).toContain("wget -qO- http://localhost:3000/manifest");
    expect(infraCompose).not.toContain("grep -q 'channel' || exit 0");
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
