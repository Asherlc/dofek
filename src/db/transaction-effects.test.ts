import { expect, it, vi } from "vitest";
import { afterCommit, runSavepointEffects, runTransactionEffects } from "./transaction-effects.ts";

it("runs effects immediately outside a transaction", () => {
  const effect = vi.fn();
  afterCommit(effect);
  expect(effect).toHaveBeenCalledOnce();
});

it("rejects savepoint observations without an active transaction", async () => {
  const operation = vi.fn();
  await expect(runSavepointEffects(operation)).rejects.toThrow(
    "Savepoint effects require an active transaction",
  );
  expect(operation).not.toHaveBeenCalled();
});

it("isolates concurrent commits from another transaction's rollback", async () => {
  let resolveEntered: () => void = () => undefined;
  let resolveRelease: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    resolveEntered = resolve;
  });
  const release = new Promise<void>((resolve) => {
    resolveRelease = resolve;
  });
  const committed = vi.fn();
  const rolledBack = vi.fn();
  const failed = runTransactionEffects(async () => {
    afterCommit(rolledBack);
    resolveEntered();
    await release;
    throw new Error("rollback");
  });
  const rejection = expect(failed).rejects.toThrow("rollback");
  await entered;
  await runTransactionEffects(async () => afterCommit(committed));
  expect(committed).toHaveBeenCalledOnce();
  expect(rolledBack).not.toHaveBeenCalled();
  resolveRelease();
  await rejection;
  expect(rolledBack).not.toHaveBeenCalled();
});

it("waits for commit and preserves the transaction result", async () => {
  const effect = vi.fn();
  const result = await runTransactionEffects(async () => {
    afterCommit(effect);
    await Promise.resolve();
    expect(effect).not.toHaveBeenCalled();
    return 42;
  });
  expect(result).toBe(42);
  expect(effect).toHaveBeenCalledOnce();
});

it("discards effects when commit fails after the transaction callback", async () => {
  const effect = vi.fn();
  await expect(
    runTransactionEffects(async () => {
      await Promise.resolve().then(() => afterCommit(effect));
      throw new Error("commit failed");
    }),
  ).rejects.toThrow("commit failed");
  expect(effect).not.toHaveBeenCalled();
});

it("flushes successful savepoints only at outer commit and discards rolled back ones", async () => {
  const effects: string[] = [];
  await runTransactionEffects(async () => {
    afterCommit(() => effects.push("outer"));
    await runSavepointEffects(async () => afterCommit(() => effects.push("nested")));
    await expect(
      runSavepointEffects(async () => {
        afterCommit(() => effects.push("rolled back"));
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(effects).toEqual([]);
  });
  expect(effects).toEqual(["outer", "nested"]);
});

it("discards successful savepoint effects when the outer commit fails", async () => {
  const effect = vi.fn();
  await expect(
    runTransactionEffects(async () => {
      await runSavepointEffects(async () => afterCommit(effect));
      throw new Error("outer commit failed");
    }),
  ).rejects.toThrow("outer commit failed");
  expect(effect).not.toHaveBeenCalled();
});

it("keeps independent transactions separate even inside another transaction context", async () => {
  const effects: string[] = [];
  await expect(
    runTransactionEffects(async () => {
      afterCommit(() => effects.push("outer"));
      await runTransactionEffects(async () => afterCommit(() => effects.push("independent")));
      expect(effects).toEqual(["independent"]);
      throw new Error("rollback outer");
    }),
  ).rejects.toThrow("rollback outer");
  expect(effects).toEqual(["independent"]);
});
