import { AsyncLocalStorage } from "node:async_hooks";

const tokenUserContext = new AsyncLocalStorage<string>();

export function runWithTokenUser<T>(userId: string, callback: () => Promise<T>): Promise<T> {
  return tokenUserContext.run(userId, callback);
}

export function getTokenUserId(): string | undefined {
  return tokenUserContext.getStore();
}
