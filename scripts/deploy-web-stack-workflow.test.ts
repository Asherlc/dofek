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
});
