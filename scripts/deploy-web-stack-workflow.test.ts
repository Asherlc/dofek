import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflowText = readFileSync(".github/workflows/deploy-web-stack.yml", "utf8");

describe("deploy-web-stack workflow", () => {
  it("keeps ClickHouse consumers quiesced when CDC configuration fails", () => {
    expect(workflowText).toContain(
      `      - name: Deploy ClickHouse consumer services
        id: deploy_stack_full
        if: success() && steps.deploy_stack_quiesced.conclusion == 'success' && steps.configure_clickhouse_cdc.conclusion == 'success'`,
    );
  });

  it("reports the operator action when consumers remain quiesced", () => {
    expect(workflowText).toContain(
      `      - name: Report quiesced ClickHouse consumers
        if: failure() && steps.deploy_stack_quiesced.conclusion == 'success' && steps.deploy_stack_full.conclusion == 'skipped'`,
    );
    expect(workflowText).toContain("ClickHouse consumers remain quiesced");
    expect(workflowText).toContain("rerun the deployment");
  });

  it("runs the destructive database-backup sweep only for the production stack", () => {
    expect(workflowText).toContain(
      `      - name: Sweep and verify expired database backups
        if: (env.DEPLOY_ENVIRONMENT == 'prod' || env.DEPLOY_ENVIRONMENT == 'production') && env.STACK_NAME == 'dofek'`,
    );
  });

  it("renders scoped service environments before validating the stack", () => {
    const renderIndex = workflowText.indexOf(
      "      - name: Render least-privilege service dotenv files",
    );
    const validationIndex = workflowText.indexOf("      - name: Validate rendered stack files");
    expect(renderIndex).toBeGreaterThan(-1);
    expect(validationIndex).toBeGreaterThan(renderIndex);
  });

  it("backfills historical exercise provenance after migrations and before rollout", () => {
    const migrationIndex = workflowText.indexOf("      - name: Run migrations");
    const backfillIndex = workflowText.indexOf(
      "      - name: Backfill historical exercise provenance",
    );
    const rolloutIndex = workflowText.indexOf(
      "      - name: Deploy stack without ClickHouse consumers",
    );
    expect(backfillIndex).toBeGreaterThan(migrationIndex);
    expect(rolloutIndex).toBeGreaterThan(backfillIndex);
    expect(workflowText.slice(backfillIndex, rolloutIndex)).toContain(
      '--env-file "$DATABASE_OPERATIONS_ENV_FILE"',
    );
    expect(workflowText.slice(backfillIndex, rolloutIndex)).toContain(
      "scripts/backfill-exercise-provenance.ts",
    );
  });
});
