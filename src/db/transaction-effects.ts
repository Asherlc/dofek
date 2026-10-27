import { AsyncLocalStorage } from "node:async_hooks";

const pendingEffects = new AsyncLocalStorage<Array<() => void>>();

/** Publish mutation observations after commit; autocommit writes publish immediately. */
export function afterCommit(effect: () => void): void {
  const effects = pendingEffects.getStore();
  if (effects) effects.push(effect);
  else effect();
}

/** The operation must include the database's COMMIT, not just its callback. */
export async function runTransactionEffects<T>(operation: () => Promise<T>): Promise<T> {
  const effects: Array<() => void> = [];
  const result = await pendingEffects.run(effects, operation);
  for (const effect of effects) effect();
  return result;
}

/** Released savepoints still depend on the outer commit; failed savepoints discard their effects. */
export async function runSavepointEffects<T>(operation: () => Promise<T>): Promise<T> {
  const parent = pendingEffects.getStore();
  if (!parent) throw new Error("Savepoint effects require an active transaction");
  const effects: Array<() => void> = [];
  const result = await pendingEffects.run(effects, operation);
  parent.push(...effects);
  return result;
}
