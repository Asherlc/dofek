export interface SleepMissingDataState {
  status: "missing";
  reason: string;
  nextAction: string;
}

export type SleepAnalyticsDataState = { status: "available" } | SleepMissingDataState;
export type MissingSleepState = Extract<SleepAnalyticsDataState, { status: "missing" }>;

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

export function getMissingSleepStates(night: {
  durationState: SleepAnalyticsDataState;
  sleepState: SleepAnalyticsDataState;
  stageState: SleepAnalyticsDataState;
}): MissingSleepState[] {
  const states = [night.durationState, night.sleepState, night.stageState].filter(
    (state): state is MissingSleepState => state.status === "missing",
  );
  return dedupeSleepMissingStates(states);
}
