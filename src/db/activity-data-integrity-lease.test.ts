import { describe, expect, it, vi } from "vitest";
import { withActivityIntegrityLease } from "./activity-data-integrity-lease.ts";

function leaseDatabase(
  query: (query: string, values?: unknown[]) => Promise<{ rows: object[] }>,
  release: () => void,
) {
  return { $client: { connect: vi.fn(async () => ({ query, release })) } };
}

describe("withActivityIntegrityLease", () => {
  it("releases the connection and preserves the operation error when unlock fails", async () => {
    const operationError = new Error("operation failed");
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockRejectedValueOnce(new Error("unlock failed"));
    const release = vi.fn();

    await expect(
      withActivityIntegrityLease(leaseDatabase(query, release), async () => {
        throw operationError;
      }),
    ).rejects.toBe(operationError);
    expect(release).toHaveBeenCalledOnce();
  });

  it("releases the connection and reports the unlock error after a successful operation", async () => {
    const unlockError = new Error("unlock failed");
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockRejectedValueOnce(unlockError);
    const release = vi.fn();

    await expect(
      withActivityIntegrityLease(leaseDatabase(query, release), async () => "done"),
    ).rejects.toBe(unlockError);
    expect(release).toHaveBeenCalledOnce();
  });
});
