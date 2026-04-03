import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..");
const dockerComposePath = join(repoRoot, "deploy", "docker-compose.yml");
const ciWorkflowPath = join(repoRoot, ".github", "workflows", "ci.yml");
const deployConfigPath = join(repoRoot, "deploy", "deploy-config", "main.tf");

describe("OTA deployment config", () => {
  it("reads the OTA bucket from env in production services", () => {
    const dockerCompose = readFileSync(dockerComposePath, "utf-8");
    const composeBucketEnv = "- R2_BUCKET=$" + "{R2_BUCKET:?Set R2_BUCKET in .env}";

    expect(dockerCompose).toContain(composeBucketEnv);
    expect(dockerCompose).not.toContain("- R2_BUCKET=dofek-training-data");
  });

  it("uses the same bucket variable in CI OTA deploy", () => {
    const ciWorkflow = readFileSync(ciWorkflowPath, "utf-8");
    const ciBucketSecret = "R2_BUCKET: $" + "{{ secrets.R2_BUCKET }}";
    const ciBucketGuard = ': "$' + '{R2_BUCKET:?Missing R2_BUCKET}"';

    expect(ciWorkflow).toContain(ciBucketSecret);
    expect(ciWorkflow).toContain(ciBucketGuard);
  });

  it("keeps deploy-config responsible for the server R2 bucket", () => {
    const deployConfig = readFileSync(deployConfigPath, "utf-8");
    const deployConfigBucketWrite = "R2_BUCKET=$" + "{var.r2_bucket}";

    expect(deployConfig).toContain('variable "r2_bucket"');
    expect(deployConfig).toContain('default     = "dofek-training-data"');
    expect(deployConfig).toContain("r2_bucket                    = var.r2_bucket");
    expect(deployConfig).toContain(deployConfigBucketWrite);
  });
});
