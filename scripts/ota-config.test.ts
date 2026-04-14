import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..");
const deployComposePath = join(repoRoot, "deploy", "docker-compose.deploy.yml");
const deployWorkflowPath = join(repoRoot, ".github", "workflows", "deploy.yml");
const deployOtaWorkflowPath = join(repoRoot, ".github", "workflows", "deploy-ota.yml");
const secretSyncWorkflowPath = join(repoRoot, ".github", "workflows", "secret-sync.yml");
const appJsonPath = join(repoRoot, "packages", "mobile", "app.json");

describe("OTA deployment config (expo-open-ota)", () => {
  it("defines the ota service in deploy compose", () => {
    const deployCompose = readFileSync(deployComposePath, "utf-8");
    expect(deployCompose).toContain("ghcr.io/axelmarciano/expo-open-ota:");
    expect(deployCompose).toContain("STORAGE_MODE: s3");
  });

  it("uses the /hc health endpoint for the ota healthcheck", () => {
    const deployCompose = readFileSync(deployComposePath, "utf-8");
    expect(deployCompose).toContain("wget -qO- http://localhost:3000/hc");
  });

  it("uses eoas publish in OTA deploy workflow", () => {
    const deployWorkflow = readFileSync(deployWorkflowPath, "utf-8");
    const otaDeployWorkflow = readFileSync(deployOtaWorkflowPath, "utf-8");
    expect(deployWorkflow).toContain("./.github/workflows/deploy-ota.yml");
    expect(otaDeployWorkflow).toMatch(/eoas.*publish/);
    expect(otaDeployWorkflow).toContain("EXPO_TOKEN");
  });

  it("publishes to main branch", () => {
    const otaDeployWorkflow = readFileSync(deployOtaWorkflowPath, "utf-8");
    expect(otaDeployWorkflow).toContain("--branch main");
  });

  it("configures code signing keys for the OTA server", () => {
    const deployCompose = readFileSync(deployComposePath, "utf-8");
    expect(deployCompose).toContain("KEYS_STORAGE_TYPE: environment");
    expect(deployCompose).toContain("PRIVATE_EXPO_KEY_B64");
    expect(deployCompose).toContain("PUBLIC_EXPO_KEY_B64");
  });

  it("fails secret sync if OTA signing keys are not set", () => {
    const secretSyncWorkflow = readFileSync(secretSyncWorkflowPath, "utf-8");
    expect(secretSyncWorkflow).toContain("OTA_PRIVATE_KEY_B64");
    expect(secretSyncWorkflow).toContain("OTA_PUBLIC_KEY_B64");
    expect(secretSyncWorkflow).toMatch(/OTA_PRIVATE_KEY_B64.*exit 1|exit 1.*OTA_PRIVATE_KEY_B64/s);
    expect(secretSyncWorkflow).toMatch(/OTA_PUBLIC_KEY_B64.*exit 1|exit 1.*OTA_PUBLIC_KEY_B64/s);
  });

  it("points mobile app at the expo-open-ota server", () => {
    const appJson = JSON.parse(readFileSync(appJsonPath, "utf-8"));
    expect(appJson.expo.updates.url).toBe("https://ota.dofek.asherlc.com/manifest");
    expect(appJson.expo.updates.requestHeaders).toHaveProperty("expo-channel-name");
  });
});
