import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..");
const previewComposePath = join(repoRoot, "deploy", "preview", "docker-compose.yml");
const previewWorkflowPath = join(repoRoot, ".github", "workflows", "preview.yml");
const readmePath = join(repoRoot, "README.md");

describe("preview environment config", () => {
  it("enables the seeded preview login path in the web container", () => {
    const previewCompose = readFileSync(previewComposePath, "utf-8");
    expect(previewCompose).toContain("ENABLE_DEV_LOGIN=true");
  });

  it("points reviewers at the seeded login endpoint", () => {
    const previewWorkflow = readFileSync(previewWorkflowPath, "utf-8");
    const readme = readFileSync(readmePath, "utf-8");

    expect(previewWorkflow).toContain("/auth/dev-login");
    expect(readme).toContain("/auth/dev-login");
  });

  it("checks PR state before deleting scheduled preview servers", () => {
    const previewWorkflow = readFileSync(previewWorkflowPath, "utf-8");

    expect(previewWorkflow).toContain("gh pr view");
    expect(previewWorkflow).toContain("--json state");
    expect(previewWorkflow).toContain('PR_STATE="');
    expect(previewWorkflow).toContain('[ "$PR_STATE" = "OPEN" ]');
  });

  it("does not use plain eas update for preview OTA publishing", () => {
    const previewWorkflow = readFileSync(previewWorkflowPath, "utf-8");

    expect(previewWorkflow).not.toContain("eas update --auto");
  });
});
