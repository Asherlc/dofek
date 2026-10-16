import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const poolClient = {
    query: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn(async () => poolClient),
    end: vi.fn(async () => undefined),
    on: vi.fn(),
  };
  return {
    captureException: vi.fn(),
    isAccountErasureActive: vi.fn(),
    loggerError: vi.fn(),
    loggerInfo: vi.fn(),
    pool,
    poolClient,
    Pool: vi.fn(function vitestConstructor() {
      return pool;
    }),
  };
});

vi.mock("@sentry/node", () => ({
  captureException: mocks.captureException,
}));

vi.mock("pg", () => ({
  Pool: mocks.Pool,
}));

vi.mock("../db/account-erasure-processing.ts", () => ({
  isAccountErasureActive: mocks.isAccountErasureActive,
}));

vi.mock("../logger.ts", () => ({
  logger: {
    error: mocks.loggerError,
    info: mocks.loggerInfo,
  },
}));

import {
  type AccountErasureWorkLockPool,
  createAccountErasureWorkLockPool,
  createAccountErasureWorkLockPoolFromEnv,
  runQueuedUserWorkUnlessAccountErasing,
} from "./account-erasure-work-guard.ts";

function createWorkLockPool(): AccountErasureWorkLockPool {
  return {
    close: vi.fn(async () => undefined),
    runWithSharedUserLock: vi.fn(async (_userId, work) => work()),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isAccountErasureActive.mockResolvedValue(false);
  mocks.poolClient.query.mockReset();
  mocks.poolClient.query.mockResolvedValue({ rows: [{ unlocked: true }] });
});

describe("PostgreSQL queued-work lock pool", () => {
  it("uses a dedicated bounded pool and closes it on shutdown", async () => {
    const workLockPool = createAccountErasureWorkLockPool("postgres://database.test/dofek");

    expect(mocks.Pool).toHaveBeenCalledWith({
      application_name: "dofek-account-erasure-work-lock",
      connectionString: "postgres://database.test/dofek",
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 300_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 60_000,
      max: 4,
    });

    await workLockPool.close();
    expect(mocks.pool.end).toHaveBeenCalledOnce();
  });

  it("holds the provider lock before the erasure barrier and releases both after work", async () => {
    const pool = createAccountErasureWorkLockPool("postgres://database.test/dofek");
    await expect(
      pool.runWithSharedUserLock(
        "user-1",
        async () => {
          expect(mocks.poolClient.query).toHaveBeenCalledTimes(2);
          expect(mocks.poolClient.release).not.toHaveBeenCalled();
          return "complete";
        },
        "mountain-project",
      ),
    ).resolves.toBe("complete");
    expect(
      mocks.poolClient.query.mock.calls.map(([query, values]) => ({
        text: query.text.trim().split("(")[0],
        values,
      })),
    ).toEqual([
      { text: "SELECT pg_advisory_lock", values: ["provider-sync:user-1:mountain-project"] },
      {
        text: "SELECT pg_advisory_lock_shared",
        values: ["account-erasure-queued-user-work:user-1"],
      },
      {
        text: "SELECT pg_advisory_unlock_shared",
        values: ["account-erasure-queued-user-work:user-1"],
      },
      { text: "SELECT pg_advisory_unlock", values: ["provider-sync:user-1:mountain-project"] },
    ]);
    expect(mocks.poolClient.on).toHaveBeenCalledWith("error", expect.any(Function));
    expect(mocks.poolClient.removeListener).toHaveBeenCalledWith(
      "error",
      mocks.poolClient.on.mock.calls[0]?.[1],
    );
    expect(mocks.poolClient.release).toHaveBeenCalledWith();
    expect(mocks.poolClient.release).toHaveBeenCalledTimes(1);
  });

  it.each([false, undefined])(
    "destroys the session when provider unlock returns %s",
    async (unlocked) => {
      const pool = createAccountErasureWorkLockPool("postgres://database.test/dofek");
      mocks.poolClient.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ unlocked: true }] })
        .mockResolvedValueOnce({ rows: unlocked === undefined ? [] : [{ unlocked }] });
      await expect(
        pool.runWithSharedUserLock("user-1", async () => "complete", "mountain-project"),
      ).rejects.toThrow("Provider sync advisory lock was not held");
      expect(mocks.poolClient.release).toHaveBeenCalledWith(true);
      expect(mocks.poolClient.release).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["capture", "log", "neither"])(
    "exits synchronously on lock-session loss even if %s reporting fails",
    async (failureStep) => {
      const pool = createAccountErasureWorkLockPool("postgres://database.test/dofek");
      let finishWork = () => {};
      const workPending = new Promise<void>((resolve) => {
        finishWork = resolve;
      });
      const running = pool.runWithSharedUserLock("user-1", () => workPending, "mountain-project");
      await vi.waitFor(() => expect(mocks.poolClient.query).toHaveBeenCalledTimes(2));
      const listener = mocks.poolClient.on.mock.calls[0]?.[1];
      if (!listener) throw new Error("Expected checked-out session protection");
      const fatal = new Error("worker exited");
      const sessionFailure = new Error("session disconnected");
      const exit = vi.spyOn(process, "exit").mockImplementation(() => {
        throw fatal;
      });
      if (failureStep === "capture")
        mocks.captureException.mockImplementationOnce(() => {
          throw new Error("capture failed");
        });
      if (failureStep === "log")
        mocks.loggerError.mockImplementationOnce(() => {
          throw new Error("logging failed");
        });
      try {
        expect(() => listener(sessionFailure)).toThrow(fatal);
        expect(exit).toHaveBeenCalledWith(1);
        expect(mocks.captureException).toHaveBeenCalledWith(sessionFailure, {
          tags: { source: "provider-sync-lock-session" },
        });
        expect(mocks.loggerError).toHaveBeenCalledWith(
          "[provider-sync-lock] PostgreSQL session lost; stopping worker to prevent stale writes",
        );
      } finally {
        exit.mockRestore();
        finishWork();
        await running;
      }
    },
  );

  it("destroys partial provider acquisition when the erasure barrier fails", async () => {
    const pool = createAccountErasureWorkLockPool("postgres://database.test/dofek");
    const failure = new Error("barrier unavailable");
    const work = vi.fn(async () => undefined);
    mocks.poolClient.query.mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(failure);
    await expect(
      pool.runWithSharedUserLock("user-1", work, "mountain-project"),
    ).rejects.toMatchObject({ cause: failure });
    expect(work).not.toHaveBeenCalled();
    expect(mocks.poolClient.release).toHaveBeenCalledWith(true);
    expect(mocks.poolClient.release).toHaveBeenCalledTimes(1);
  });

  it("preserves a synchronous callback failure if provider unlock fails", async () => {
    const pool = createAccountErasureWorkLockPool("postgres://database.test/dofek");
    const failure = new Error("sync failed");
    const unlockFailure = new Error("provider unlock failed");
    mocks.poolClient.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ unlocked: true }] })
      .mockRejectedValueOnce(unlockFailure);
    await expect(
      pool.runWithSharedUserLock(
        "user-1",
        () => {
          throw failure;
        },
        "mountain-project",
      ),
    ).rejects.toBe(failure);
    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ cause: unlockFailure }),
      expect.any(Object),
    );
    expect(mocks.poolClient.release).toHaveBeenCalledWith(true);
    expect(mocks.poolClient.release).toHaveBeenCalledTimes(1);
  });

  it("uses the configured database and fails explicitly when DATABASE_URL is missing", async () => {
    const original = process.env.DATABASE_URL;
    try {
      delete process.env.DATABASE_URL;
      expect(() => createAccountErasureWorkLockPoolFromEnv()).toThrow(
        "DATABASE_URL environment variable is required",
      );
      process.env.DATABASE_URL = "postgres://configured.test/dofek";
      const pool = createAccountErasureWorkLockPoolFromEnv();
      expect(mocks.Pool).toHaveBeenCalledWith(
        expect.objectContaining({ connectionString: "postgres://configured.test/dofek" }),
      );
      await pool.close();
    } finally {
      if (original === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = original;
    }
  });

  it("reports idle pool errors through the pool handler", () => {
    createAccountErasureWorkLockPool("postgres://database.test/dofek");
    const listener = mocks.pool.on.mock.calls[0]?.[1];
    if (!listener) throw new Error("Expected idle pool error handler");
    const failure = new Error("idle connection failed");
    listener(failure);
    expect(mocks.captureException).toHaveBeenCalledWith(failure, {
      tags: { source: "account-erasure-work-lock-pool" },
    });
    expect(mocks.loggerError).toHaveBeenCalledWith(
      "[account-erasure-work-lock] PostgreSQL pool idle client error: idle connection failed",
    );
  });

  it("queues lock work before asking PostgreSQL for a fifth session", async () => {
    let releaseStartedWork: (() => void) | undefined;
    const allWorkStarted = new Promise<void>((resolve) => {
      releaseStartedWork = resolve;
    });
    const releaseWork: Array<() => void> = [];
    let startedWork = 0;
    const workLockPool = createAccountErasureWorkLockPool("postgres://database.test/dofek");

    const activeWork = Array.from({ length: 4 }, (_, index) =>
      workLockPool.runWithSharedUserLock(`user-${index}`, () => {
        startedWork++;
        if (startedWork === 4) releaseStartedWork?.();
        return new Promise<void>((resolve) => releaseWork.push(resolve));
      }),
    );
    await allWorkStarted;

    const fifthWork = workLockPool.runWithSharedUserLock("user-5", async () => "fifth");
    await Promise.resolve();

    expect(mocks.pool.connect).toHaveBeenCalledTimes(4);

    for (const release of releaseWork) release();
    await expect(Promise.all(activeWork)).resolves.toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    await vi.waitFor(() => expect(mocks.pool.connect).toHaveBeenCalledTimes(5));
    await expect(fifthWork).resolves.toBe("fifth");
    expect(mocks.pool.connect).toHaveBeenCalledTimes(5);
    let releaseNext = () => {};
    const nextReleased = new Promise<void>((resolve) => {
      releaseNext = resolve;
    });
    let nextStarted = 0;
    const nextBatch = Array.from({ length: 4 }, (_, index) =>
      workLockPool.runWithSharedUserLock(`next-${index}`, async () => {
        nextStarted++;
        await nextReleased;
      }),
    );
    try {
      await vi.waitFor(() => expect(nextStarted).toBe(4));
    } finally {
      releaseNext();
      await Promise.all(nextBatch);
    }
  });

  it("reports PostgreSQL lock-acquisition failures and releases the client", async () => {
    const workLockPool = createAccountErasureWorkLockPool("postgres://database.test/dofek");
    const failure = new Error("database unavailable");
    mocks.poolClient.query.mockRejectedValueOnce(failure);

    await expect(
      workLockPool.runWithSharedUserLock("user-1", async () => "must-not-run"),
    ).rejects.toMatchObject({ cause: failure });

    expect(mocks.poolClient.release).toHaveBeenCalledWith(true);
    expect(mocks.poolClient.release).toHaveBeenCalledTimes(1);
    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ cause: failure }),
      {
        tags: {
          accountErasureWorkLockStep: "acquire",
          source: "account-erasure-work-lock",
        },
      },
    );
  });

  it("fails closed when PostgreSQL reports that the shared lock was not held", async () => {
    const workLockPool = createAccountErasureWorkLockPool("postgres://database.test/dofek");
    mocks.poolClient.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ unlocked: false }] });

    await expect(
      workLockPool.runWithSharedUserLock("user-1", async () => "completed"),
    ).rejects.toThrow("Queued user work advisory lock was not held by its PostgreSQL session");

    expect(mocks.poolClient.release).toHaveBeenCalledWith(true);
    expect(mocks.poolClient.release).toHaveBeenCalledTimes(1);
    expect(mocks.captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: {
        accountErasureWorkLockStep: "release",
        source: "account-erasure-work-lock",
      },
    });
  });

  it("fails closed when PostgreSQL returns no advisory unlock row", async () => {
    const workLockPool = createAccountErasureWorkLockPool("postgres://database.test/dofek");
    mocks.poolClient.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });

    const error = await workLockPool
      .runWithSharedUserLock("user-1", async () => "completed")
      .catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      message: "Queued user work advisory lock was not held by its PostgreSQL session",
    });
    expect(mocks.captureException).toHaveBeenCalledWith(error, {
      tags: {
        accountErasureWorkLockStep: "release",
        source: "account-erasure-work-lock",
      },
    });
    expect(mocks.poolClient.release).toHaveBeenCalledWith(true);
    expect(mocks.poolClient.release).toHaveBeenCalledTimes(1);
  });

  it("preserves a callback failure when PostgreSQL cannot release the shared lock", async () => {
    const workLockPool = createAccountErasureWorkLockPool("postgres://database.test/dofek");
    const workFailure = new Error("job failed");
    const releaseFailure = new Error("unlock failed");
    mocks.poolClient.query
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(releaseFailure);

    await expect(
      workLockPool.runWithSharedUserLock("user-1", async () => {
        throw workFailure;
      }),
    ).rejects.toBe(workFailure);

    expect(mocks.poolClient.release).toHaveBeenCalledWith(true);
    expect(mocks.poolClient.release).toHaveBeenCalledTimes(1);
    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ cause: releaseFailure }),
      {
        tags: {
          accountErasureWorkLockStep: "release",
          source: "account-erasure-work-lock",
        },
      },
    );
  });

  it("restores permit capacity after work completes without queued callers", async () => {
    const workLockPool = createAccountErasureWorkLockPool("postgres://database.test/dofek");

    for (const [userId, result] of [
      ["user-1", "first"],
      ["user-2", "second"],
      ["user-3", "third"],
      ["user-4", "fourth"],
      ["user-5", "fifth"],
    ] as const) {
      await expect(workLockPool.runWithSharedUserLock(userId, async () => result)).resolves.toBe(
        result,
      );
    }

    expect(mocks.pool.connect).toHaveBeenCalledTimes(5);
  });

  it("holds and releases the same session lock around the complete job callback", async () => {
    const workLockPool = createAccountErasureWorkLockPool("postgres://database.test/dofek");
    const work = vi.fn(async () => {
      expect(mocks.poolClient.release).not.toHaveBeenCalled();
      return "completed";
    });

    await expect(workLockPool.runWithSharedUserLock("user-1", work)).resolves.toBe("completed");

    expect(mocks.poolClient.on).not.toHaveBeenCalled();
    expect(mocks.poolClient.removeListener).not.toHaveBeenCalled();
    expect(mocks.poolClient.release).toHaveBeenCalledTimes(1);
    expect(mocks.poolClient.query).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        text: expect.stringContaining("SELECT pg_advisory_lock_shared"),
      }),
      ["account-erasure-queued-user-work:user-1"],
    );
    expect(mocks.poolClient.query).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        text: expect.stringContaining("SELECT pg_advisory_unlock_shared"),
      }),
      ["account-erasure-queued-user-work:user-1"],
    );
    expect(mocks.poolClient.release).toHaveBeenCalledWith();
  });

  it("releases the shared session lock when a job throws synchronously", async () => {
    const workLockPool = createAccountErasureWorkLockPool("postgres://database.test/dofek");
    const failure = new Error("job failed");

    await expect(
      workLockPool.runWithSharedUserLock("user-1", () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(mocks.poolClient.query).toHaveBeenCalledTimes(2);
    expect(mocks.poolClient.release).toHaveBeenCalledWith();
  });
});

describe("runQueuedUserWorkUnlessAccountErasing", () => {
  it("passes provider scope to the work lock before checking the erasure fence", async () => {
    const pool = createWorkLockPool();
    await runQueuedUserWorkUnlessAccountErasing(
      pool,
      { execute: vi.fn() },
      "user-1",
      "sync",
      async () => "done",
      "mountain-project",
    );
    expect(pool.runWithSharedUserLock).toHaveBeenCalledWith(
      "user-1",
      expect.any(Function),
      "mountain-project",
    );
  });

  it("runs queued work when the user has no account-erasure fence", async () => {
    const database = { execute: vi.fn() };
    const work = vi.fn(async () => "completed");

    await expect(
      runQueuedUserWorkUnlessAccountErasing(createWorkLockPool(), database, "user-1", "sync", work),
    ).resolves.toBe("completed");

    expect(mocks.isAccountErasureActive).toHaveBeenCalledWith(database, "user-1");
    expect(work).toHaveBeenCalledOnce();
  });

  it("discards queued work when account erasure is active", async () => {
    mocks.isAccountErasureActive.mockResolvedValue(true);
    const work = vi.fn(async () => "must-not-run");

    await expect(
      runQueuedUserWorkUnlessAccountErasing(
        createWorkLockPool(),
        { execute: vi.fn() },
        "user-1",
        "file import",
        work,
      ),
    ).resolves.toBeUndefined();

    expect(work).not.toHaveBeenCalled();
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "[worker] Discarding file import because account erasure is active",
    );
    expect(JSON.stringify(mocks.loggerInfo.mock.calls)).not.toContain("user-1");
  });

  it("fails closed when the account-erasure state cannot be checked", async () => {
    const failure = new Error("database unavailable");
    mocks.isAccountErasureActive.mockRejectedValue(failure);
    const work = vi.fn(async () => undefined);

    await expect(
      runQueuedUserWorkUnlessAccountErasing(
        createWorkLockPool(),
        { execute: vi.fn() },
        "user-1",
        "export",
        work,
      ),
    ).rejects.toBe(failure);

    expect(work).not.toHaveBeenCalled();
  });
});
