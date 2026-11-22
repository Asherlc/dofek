import { formatDurationMinutes, formatTimeOnly } from "./format.ts";

interface SleepNightLabelInput {
  actualOnset: string | null;
  sleepProvider: string;
}

/** Describes an onset offset relative to the habitual onset. */
export function timingLabel(minutes: number | null): string | null {
  if (minutes === null) return null;
  if (Math.round(minutes) === 0) return "At usual onset";
  return `${formatDurationMinutes(Math.abs(minutes))} ${minutes < 0 ? "before" : "after"} usual onset`;
}

/** Disambiguates several sleep records that share one wake date; null when the date has one record. */
export function sameDateNightLabel<Night extends SleepNightLabelInput>(
  night: Night,
  sameDate: readonly Night[] | undefined,
  timezone: string,
  providerName: (providerId: string) => string,
): string | null {
  if (!sameDate || sameDate.length < 2) return null;
  const onsetClock = (episode: SleepNightLabelInput) =>
    episode.actualOnset === null
      ? null
      : formatTimeOnly(episode.actualOnset, { timeZone: timezone });
  const onset = onsetClock(night);
  const sameOnset = sameDate.filter((episode) => onsetClock(episode) === onset);
  if (onset && sameOnset.length === 1) return `Onset ${onset}`;
  const source = providerName(night.sleepProvider);
  const sameProvider = sameOnset.filter(
    (episode) => providerName(episode.sleepProvider) === source,
  );
  const provider =
    sameProvider.length > 1 ? `${source} · Record ${sameProvider.indexOf(night) + 1}` : source;
  return onset ? `Onset ${onset} · ${provider}` : provider;
}
