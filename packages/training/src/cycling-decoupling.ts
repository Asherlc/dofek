export function round(value: number, decimals = 1): number {
  const multiplier = 10 ** decimals;
  return Math.round(value * multiplier) / multiplier;
}

export function pairedEfficiency(
  power: Array<number | null>,
  heartRate: Array<number | null>,
  start = 0,
  end = power.length,
): { ratio: number | null; seconds: number; powerTotal: number; heartRateTotal: number } {
  let powerTotal = 0;
  let heartRateTotal = 0;
  let seconds = 0;
  for (let index = start; index < end; index++) {
    const watts = power[index];
    const bpm = heartRate[index];
    if (
      watts == null ||
      bpm == null ||
      bpm <= 0 ||
      watts < 0 ||
      !Number.isFinite(watts) ||
      !Number.isFinite(bpm)
    )
      continue;
    powerTotal += watts;
    heartRateTotal += bpm;
    seconds++;
  }
  return {
    ratio: seconds > 0 && heartRateTotal > 0 ? powerTotal / heartRateTotal : null,
    seconds,
    powerTotal,
    heartRateTotal,
  };
}

export function summarizeCyclingDecoupling(
  power: Array<number | null>,
  heartRate: Array<number | null>,
) {
  const midpoint = Math.floor(power.length / 2);
  const summarizeHalf = (start: number, end: number) => {
    const { ratio, seconds, powerTotal, heartRateTotal } = pairedEfficiency(
      power,
      heartRate,
      start,
      end,
    );
    return {
      ratio,
      pairedSeconds: seconds,
      meanWatts: seconds > 0 ? round(powerTotal / seconds) : null,
      meanBpm: seconds > 0 ? round(heartRateTotal / seconds) : null,
      coveragePct: end > start ? round((seconds / (end - start)) * 100) : 0,
    };
  };
  const firstHalf = summarizeHalf(0, midpoint);
  const secondHalf = summarizeHalf(midpoint, power.length);
  let percent: number | null = null;
  if (
    power.length >= 1200 &&
    firstHalf.pairedSeconds >= midpoint * 0.9 &&
    secondHalf.pairedSeconds >= (power.length - midpoint) * 0.9 &&
    firstHalf.ratio !== null &&
    firstHalf.ratio > 0 &&
    Number.isFinite(firstHalf.ratio) &&
    secondHalf.ratio !== null
  ) {
    const change = ((firstHalf.ratio - secondHalf.ratio) / firstHalf.ratio) * 100;
    if (Number.isFinite(change)) percent = round(change);
  }
  return {
    percent,
    firstHalf,
    secondHalf,
    method: "equal_elapsed_time_halves_power_to_heart_rate" as const,
  };
}
