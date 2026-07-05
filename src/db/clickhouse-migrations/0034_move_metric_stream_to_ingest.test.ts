import { describe, expect, it, vi } from "vitest";
import { createMigration } from "./0034_move_metric_stream_to_ingest.ts";

describe("0034_move_metric_stream_to_ingest", () => {
  it("skips copying when the legacy metric_stream table does not exist", async () => {
    const command = vi.fn();
    const client = {
      query: vi.fn().mockResolvedValue({
        json: async () => [{ count: "0" }],
      }),
      command,
    };

    await createMigration().run(client);

    expect(command).not.toHaveBeenCalled();
  });

  it("copies and drops the legacy table when it exists", async () => {
    const command = vi.fn();
    const client = {
      query: vi.fn().mockResolvedValue({
        json: async () => [{ count: "1" }],
      }),
      command,
    };

    await createMigration().run(client);

    expect(command).toHaveBeenCalledTimes(2);
    expect(command.mock.calls[0]?.[0]?.query).toContain("INSERT INTO");
    expect(command.mock.calls[1]?.[0]?.query).toContain("DROP TABLE IF EXISTS");
  });
});
