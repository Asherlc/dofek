import type { AccountErasureIdentifierStore } from "./identifier-store.ts";
/** In-memory retained identities for archive storage/stream tests; PG semantics have their own engine suite. */
export function archiveIdentityFixture(
  activity: readonly string[] = [],
  operation: readonly string[] = [],
): Pick<
  AccountErasureIdentifierStore,
  "findPresent" | "assertClosureComplete" | "loadPhysicalProgress"
> {
  return {
    assertClosureComplete: async () => undefined,
    loadPhysicalProgress: async () => ({ step: "complete" }),
    findPresent: async (family, values) =>
      values.filter((value) =>
        (family === "activity" ? activity : family === "operation" ? operation : []).includes(
          value,
        ),
      ),
  };
}
