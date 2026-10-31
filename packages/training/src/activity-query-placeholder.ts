/** Retain a chart during source changes, never across activity navigation. */
export function activityQueryPlaceholder(activityId: string | undefined) {
  return <T>(
    previousData: T | undefined,
    previousQuery: { queryKey: readonly unknown[] } | undefined,
  ): T | undefined => {
    const key = previousQuery?.queryKey[1];
    const input = key && typeof key === "object" && "input" in key ? key.input : undefined;
    return activityId &&
      input &&
      typeof input === "object" &&
      "id" in input &&
      input.id === activityId
      ? previousData
      : undefined;
  };
}
