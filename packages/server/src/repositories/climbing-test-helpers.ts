import type { ClimbingActivityEntryRow } from "../contracts/climbing-context-contracts.ts";

export function emptyClimbingContext(providerId: string): ClimbingActivityEntryRow["context"] {
  return {
    providerId,
    locationPath: [],
    board: null,
    wallAngle: null,
    climbStyle: null,
    resultStyle: null,
  };
}

export function queryText(query: unknown): string {
  if (typeof query !== "object" || query === null || !("queryChunks" in query)) {
    throw new Error("Expected Drizzle SQL query object");
  }

  const queryChunks = Reflect.get(query, "queryChunks");
  return JSON.stringify(queryChunks);
}
