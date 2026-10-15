import { beforeEach, describe, expect, it, vi } from "vitest";

const { captureException } = vi.hoisted(() => ({ captureException: vi.fn() }));

vi.mock("../lib/error-reporting.ts", () => ({ captureException }));

import { withActivityIntegrityLease } from "./activity-data-integrity-lease.ts";

type ConnectionErrorListener = (error: Error) => void;

function leaseDatabase(
  query: (query: string, values?: unknown[]) => Promise<{ rows: object[] }>,
  release: (destroy?: boolean) => void,
  connectionEvents: {
    on?: (event: "error", listener: ConnectionErrorListener) => void;
    off?: (event: "error", listener: ConnectionErrorListener) => void;
  } = {},
) {
  const connection = {
    off: connectionEvents.off ?? vi.fn(),
    on: connectionEvents.on ?? vi.fn(),
    query,
    release,
  };
  return { $client: { connect: vi.fn(async () => connection) } };
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

  it("fails the operation and destroys the connection when PostgreSQL ends the lease session", async () => {
    const sessionFailure = new Error("terminating connection due to administrator command");
    const listeners: ConnectionErrorListener[] = [];
    const on = vi.fn((_event: "error", listener: ConnectionErrorListener) => {
      listeners.push(listener);
    });
    const off = vi.fn();
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ acquired: true }] });
    const release = vi.fn();

    const error = await withActivityIntegrityLease(
      leaseDatabase(query, release, { off, on }),
      async () => {
        for (const listener of listeners) listener(sessionFailure);
        return "done";
      },
    ).catch((failure: unknown) => failure);

    expect(on).toHaveBeenCalledWith("error", expect.any(Function));
    expect(error).toMatchObject({
      cause: sessionFailure,
      message: "activity integrity lease was lost with its PostgreSQL session",
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(true);
    expect(off).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledWith(sessionFailure, {
      tags: { source: "activity-integrity-lease" },
    });
  });

  it("preserves the operation error when PostgreSQL ends the lease session", async () => {
    const operationError = new Error("operation failed");
    const listeners: ConnectionErrorListener[] = [];
    const on = vi.fn((_event: "error", listener: ConnectionErrorListener) => {
      listeners.push(listener);
    });
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ acquired: true }] });
    const release = vi.fn();

    await expect(
      withActivityIntegrityLease(leaseDatabase(query, release, { on }), async () => {
        for (const listener of listeners) listener(new Error("Connection terminated unexpectedly"));
        throw operationError;
      }),
    ).rejects.toBe(operationError);
    expect(release).toHaveBeenCalledWith(true);
  });

  it("detaches its session error listener before returning a healthy connection to the pool", async () => {
    const on = vi.fn();
    const off = vi.fn();
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockResolvedValueOnce({ rows: [] });
    const release = vi.fn();

    await expect(
      withActivityIntegrityLease(leaseDatabase(query, release, { off, on }), async () => "done"),
    ).resolves.toBe("done");

    const [event, listener] = on.mock.calls[0] ?? [];
    expect(event).toBe("error");
    expect(off).toHaveBeenCalledWith("error", listener);
    expect(off.mock.invocationCallOrder[0]).toBeLessThan(release.mock.invocationCallOrder[0] ?? 0);
  });
});
