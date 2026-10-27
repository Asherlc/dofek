import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendPlainTextEmail } from "../email.ts";
import type { Database } from "./index.ts";
import { notifyProviderSyncIssue } from "./provider-issue-notification.ts";
import type { SchemaExecutionDatabase } from "./typed-sql.ts";

const { execute } = vi.hoisted(() => ({ execute: vi.fn<SchemaExecutionDatabase["execute"]>() }));
vi.mock("../email.ts", () => ({ sendPlainTextEmail: vi.fn() }));
vi.mock("./account-erasure.ts", () => ({
  withAccountErasureUserWriteFence: async (
    _database: Pick<Database, "transaction">,
    _userId: string,
    operation: (transaction: SchemaExecutionDatabase) => Promise<void>,
  ) => operation({ execute }),
}));
const db: Pick<Database, "transaction"> = {
  async transaction<T>(): Promise<T> {
    throw new Error("Notification unit tests must use the mocked account-erasure fence");
  },
};

describe("provider issue email content", () => {
  beforeEach(() => {
    execute.mockReset();
    execute.mockResolvedValue([]);
    vi.mocked(sendPlainTextEmail).mockReset();
    vi.mocked(sendPlainTextEmail).mockResolvedValue(undefined);
  });

  it("addresses an authorization warning to the connection owner and links to reconnection", async () => {
    execute.mockResolvedValue([
      {
        email: "owner@example.test",
        provider_name: "Test Provider",
        auth_failure_reason: "session_expired",
      },
    ]);

    await notifyProviderSyncIssue(db, "user-123", "provider/with spaces");

    expect(sendPlainTextEmail).toHaveBeenCalledExactlyOnceWith({
      toEmail: "owner@example.test",
      subject: "Your Test Provider connection needs attention",
      text: expect.stringContaining("Reconnect Test Provider"),
      signal: expect.any(AbortSignal),
    });
    expect(vi.mocked(sendPlainTextEmail).mock.calls[0]?.[0].text).toContain(
      "https://dofek.fit/providers/provider%2Fwith%20spaces",
    );
  });

  it("explains automatic retries for repeated sync failures", async () => {
    execute.mockResolvedValue([
      {
        email: "owner@example.test",
        provider_name: "Test Provider",
        auth_failure_reason: null,
      },
    ]);

    await notifyProviderSyncIssue(db, "user-123", "test-provider");

    expect(sendPlainTextEmail).toHaveBeenCalledExactlyOnceWith({
      toEmail: "owner@example.test",
      subject: "Your Test Provider connection needs attention",
      text: expect.stringContaining("We will keep trying automatically"),
      signal: expect.any(AbortSignal),
    });
  });

  it("skips sending when the connection is not eligible", async () => {
    await notifyProviderSyncIssue(db, "user-123", "test-provider");

    expect(sendPlainTextEmail).not.toHaveBeenCalled();
  });

  it("propagates a sender rejection so the sync logger can report delivery failure", async () => {
    execute.mockResolvedValue([
      {
        email: "owner@example.test",
        provider_name: "Test Provider",
        auth_failure_reason: "session_expired",
      },
    ]);
    const rejection = new Error("Email service unavailable");
    vi.mocked(sendPlainTextEmail).mockRejectedValueOnce(rejection);

    await expect(notifyProviderSyncIssue(db, "user-123", "test-provider")).rejects.toBe(rejection);
  });
});
