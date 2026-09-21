export interface NamedResourceCleanup {
  name: string;
  close: () => Promise<unknown> | unknown;
}

/** Settle every cleanup before reporting all failures to the caller. */
export async function closeResources(resources: readonly NamedResourceCleanup[]): Promise<void> {
  const results = await Promise.allSettled(
    resources.map((resource) => Promise.resolve().then(resource.close)),
  );
  const failures = results.flatMap((result, index) =>
    result.status === "rejected"
      ? [{ name: resources[index]?.name ?? "unknown resource", reason: result.reason }]
      : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      `Resource cleanup failed for: ${failures.map((failure) => failure.name).join(", ")}`,
    );
  }
}
