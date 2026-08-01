export interface SleepMissingDataState {
  status: "missing";
  reason: string;
  nextAction: string;
}

export function dedupeSleepMissingStates<T extends SleepMissingDataState>(
  states: readonly T[],
): T[] {
  const seen = new Set<string>();
  return states.filter((state) => {
    const key = `${state.reason}\u0000${state.nextAction}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
