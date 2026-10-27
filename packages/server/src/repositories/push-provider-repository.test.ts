import { providerLabel } from "@dofek/providers/providers";
import { BLE_HEART_RATE_PROVIDER_ID } from "@dofek/providers/push-providers";
import { describe, expect, it, vi } from "vitest";
import { ensurePushProvider } from "./push-provider-repository.ts";
import { collectSqlText } from "./test-helpers.ts";

describe("ensurePushProvider", () => {
  it("atomically ensures the global catalog row and user connection", async () => {
    const execute = vi.fn().mockResolvedValue([]);

    await ensurePushProvider({
      database: { execute },
      providerId: BLE_HEART_RATE_PROVIDER_ID,
      userId: "user-b",
    });

    expect(execute).toHaveBeenCalledOnce();
    const queryText = collectSqlText(execute.mock.calls[0]?.[0]);
    expect(queryText).toContain("INSERT INTO fitness.provider");
    expect(queryText).toContain("INSERT INTO fitness.provider_connection");
    expect(queryText).toContain("ON CONFLICT (user_id, provider_id) DO NOTHING");
    expect(JSON.stringify(execute.mock.calls[0]?.[0])).toContain(BLE_HEART_RATE_PROVIDER_ID);
    expect(JSON.stringify(execute.mock.calls[0]?.[0])).toContain(
      providerLabel(BLE_HEART_RATE_PROVIDER_ID),
    );
    expect(JSON.stringify(execute.mock.calls[0]?.[0])).toContain("user-b");
  });
});
