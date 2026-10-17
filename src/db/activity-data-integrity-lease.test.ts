import { beforeEach, describe, expect, it, vi } from "vitest";

const { captureException } = vi.hoisted(() => ({ captureException: vi.fn() }));

vi.mock("../lib/error-reporting.ts", () => ({ captureException }));

import { withActivityIntegrityLease } from "./activity-data-integrity-lease.ts";

function leaseDatabase(
  query: (query: string, values?: unknown[]) => Promise<{ rows: object[] }>,
  release: (destroy?: boolean) => void,
) {
  const connection = { off: vi.fn(), on: vi.fn(), query, release };
  return { $client: { connect: vi.fn(async () => connection) }, connection };
}

beforeEach(() => {
  vi.clearAllMocks();
});

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
    expect(release).toHaveBeenCalledWith(true);
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
    expect(release).toHaveBeenCalledWith(true);
  });

  it("returns a successfully unlocked connection to the pool", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockResolvedValueOnce({ rows: [] });
    const release = vi.fn();

    await expect(
      withActivityIntegrityLease(leaseDatabase(query, release), async () => "done"),
    ).resolves.toBe("done");
    expect(release).toHaveBeenCalledWith();
  });

  it.each([false, true])(
    "stops synchronously on session loss when reporting throws: %s",
    async (reportingThrows) => {
      const query = vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ acquired: true }] })
        .mockResolvedValueOnce({ rows: [] });
      const database = leaseDatabase(query, vi.fn());
      const sessionFailure = new Error("session disconnected");
      let finishOperation = () => {};
      const operationPending = new Promise<void>((resolve) => {
        finishOperation = resolve;
      });
      const running = withActivityIntegrityLease(database, () => operationPending);
      await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
      const [, listener] = database.connection.on.mock.calls[0] ?? [];
      const fatal = new Error("process exited");
      const exit = vi.spyOn(process, "exit").mockImplementation(() => {
        throw fatal;
      });
      if (reportingThrows)
        captureException.mockImplementationOnce(() => {
          throw new Error("capture failed");
        });
      try {
        expect(() => listener(sessionFailure)).toThrow(fatal);
        expect(exit).toHaveBeenCalledWith(1);
        expect(captureException).toHaveBeenCalledWith(sessionFailure, {
          tags: { source: "activity-integrity-lease" },
        });
      } finally {
        exit.mockRestore();
        finishOperation();
        await running;
      }
    },
  );

  it("does not start the operation after losing its session during lease acquisition", async () => {
    const query = vi.fn();
    const database = leaseDatabase(query, vi.fn());
    const fatal = new Error("process exited");
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw fatal;
    });
    query.mockImplementationOnce(async () => {
      const [, listener] = database.connection.on.mock.calls[0] ?? [];
      listener(new Error("session disconnected"));
      return { rows: [{ acquired: true }] };
    });
    const operation = vi.fn(async () => "must-not-run");
    try {
      await expect(withActivityIntegrityLease(database, operation)).rejects.toBe(fatal);
      expect(operation).not.toHaveBeenCalled();
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      exit.mockRestore();
    }
  });

  it("detaches its session error listener before returning a healthy connection to the pool", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockResolvedValueOnce({ rows: [] });
    const release = vi.fn();
    const database = leaseDatabase(query, release);

    await expect(withActivityIntegrityLease(database, async () => "done")).resolves.toBe("done");

    const { off, on } = database.connection;
    const [event, listener] = on.mock.calls[0] ?? [];
    expect(event).toBe("error");
    expect(off).toHaveBeenCalledWith("error", listener);
    expect(off.mock.invocationCallOrder[0]).toBeLessThan(release.mock.invocationCallOrder[0] ?? 0);
  });
});
