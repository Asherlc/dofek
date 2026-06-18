import { replaceActivityMirrorOrderKey } from "./custom-runs.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0030_activity_mirror_order_key",
    statements: [],
    run: replaceActivityMirrorOrderKey,
  };
}
