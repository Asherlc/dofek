import {
  formatDateLong,
  formatDateMedium,
  formatDateShort,
  formatDurationMinutes,
  formatTimeOnly,
} from "@dofek/format/format";
import { userFacingErrorMessage } from "@dofek/format/user-facing-error";
import { providerLabel } from "@dofek/providers/providers";
import type { LateWorkoutSleep, LateWorkoutSleepNight } from "@dofek/training/late-workout-sleep";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Svg, { Circle, Line, Rect } from "react-native-svg";
import { openExternalUrl } from "../lib/open-external-url";
import { colors } from "../theme";
import { QueryStatePanel } from "./QueryStatePanel";

interface LateWorkoutSleepCardProps {
  data?: LateWorkoutSleep;
  error?: { message: string } | null;
  isLoading?: boolean;
  isFetching?: boolean;
}

// Wake dates are calendar labels already resolved by the server.
const calendarDateOptions = { timeZone: "UTC" };

function timingLabel(minutes: number | null) {
  if (minutes === null) return null;
  if (Math.round(minutes) === 0) return "At usual onset";
  return `${formatDurationMinutes(Math.abs(minutes))} ${minutes < 0 ? "before" : "after"} usual onset`;
}

function sameDateNightLabel(
  night: LateWorkoutSleepNight,
  sameDate: LateWorkoutSleepNight[] | undefined,
  timezone: string,
) {
  if (!sameDate || sameDate.length < 2) return null;
  const onsetClock = (episode: LateWorkoutSleepNight) =>
    episode.actualOnset === null
      ? null
      : formatTimeOnly(episode.actualOnset, { timeZone: timezone });
  const onset = onsetClock(night);
  const sameOnset = sameDate.filter((episode) => onsetClock(episode) === onset);
  if (onset && sameOnset.length === 1) return `Onset ${onset}`;
  const source = providerLabel(night.sleepProvider);
  const sameProvider = sameOnset.filter(
    (episode) => providerLabel(episode.sleepProvider) === source,
  );
  const provider =
    sameProvider.length > 1 ? `${source} · Record ${sameProvider.indexOf(night) + 1}` : source;
  return onset ? `Onset ${onset} · ${provider}` : provider;
}

function NightEvidence({ night, timezone }: { night: LateWorkoutSleepNight; timezone: string }) {
  const [showSources, setShowSources] = useState(false);
  const clock = (value: string | null) =>
    value === null ? "Unavailable" : formatTimeOnly(value, { timeZone: timezone });
  const reference = night.habitualOnset;
  const load = night.load;
  const maximumsByDate = new Map(load.maximums.map((maximum) => [maximum.date, maximum]));
  const finishTiming = timingLabel(night.finishOffsetMinutes);
  const onsetTiming = timingLabel(night.actualOnsetOffsetMinutes);
  return (
    <View style={styles.evidence}>
      <Text accessibilityRole="header" style={styles.heading}>
        Night ending {formatDateLong(night.date, calendarDateOptions)}
      </Text>
      <Text style={[styles.text, styles.category]}>
        {load.category === null || load.score === null
          ? "Load unavailable"
          : `${load.category} · ${Number(load.score.toFixed(1))} points`}
      </Text>
      {night.reason && <Text style={styles.text}>{night.reason}</Text>}
      {load.reason && load.reason !== night.reason && (
        <Text style={styles.text}>{load.reason}</Text>
      )}
      <View style={styles.readings}>
        <View style={styles.reading}>
          <Text style={styles.muted}>Workout finished</Text>
          <Text style={styles.heading}>{clock(night.workoutFinish)}</Text>
          {finishTiming && <Text style={styles.text}>{finishTiming}</Text>}
        </View>
        <View style={styles.reading}>
          <Text style={styles.muted}>Fell asleep</Text>
          <Text style={styles.heading}>{clock(night.actualOnset)}</Text>
          {onsetTiming && <Text style={styles.text}>{onsetTiming}</Text>}
          {night.minutesFromFinishToSleep !== null && (
            <Text style={styles.text}>
              {formatDurationMinutes(night.minutesFromFinishToSleep)} after workout
            </Text>
          )}
        </View>
        <View style={styles.reading}>
          <Text style={styles.muted}>Time asleep</Text>
          <Text style={styles.heading}>
            {night.durationMinutes === null
              ? (night.durationReason ?? "Unavailable")
              : formatDurationMinutes(night.durationMinutes)}
          </Text>
        </View>
      </View>
      <Text style={styles.muted}>
        Sleep record from {providerLabel(night.sleepProvider)} · Usual onset{" "}
        {clock(reference.timestamp)}
      </Text>
      {reference.reason && <Text style={styles.text}>{reference.reason}</Text>}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: showSources }}
        onPress={() => setShowSources(!showSources)}
        style={styles.button}
      >
        <Text style={styles.heading}>Source records and reference nights</Text>
      </Pressable>
      {showSources && (
        <View style={styles.stack}>
          <Text style={styles.text}>
            Sleep records from {night.sourceProviders.map(providerLabel).join(", ")} ·{" "}
            {night.sourceSessionIds.join(", ")}
          </Text>
          {night.workouts.map((workout) => (
            <Text style={styles.text} key={workout.id}>
              Workout {workout.id} · {workout.sourceProviders.map(providerLabel).join(", ")} ·{" "}
              {clock(workout.startedAt)} to {clock(workout.endedAt)}
              {workout.fitMemberId && ` · FIT record ${workout.fitMemberId}`}
              {workout.reason && ` · ${workout.reason}`}
            </Text>
          ))}
          <Text style={styles.text}>
            {reference.observedCount} {reference.dayClass} reference nights · {reference.month} ·{" "}
            {reference.timezone}
          </Text>
          {reference.referenceNights.map((record) => (
            <Text style={styles.text} key={record.episodeId}>
              {formatDateShort(record.date, calendarDateOptions)} ·{" "}
              {providerLabel(record.sleepProvider)} · {record.episodeId}
            </Text>
          ))}
          {reference.ambiguousReferenceDates.map((date) => (
            <Text style={styles.text} key={date}>
              {formatDateShort(date, calendarDateOptions)} · Multiple sleep records
            </Text>
          ))}
          {load.coveredSeconds !== null && (
            <Text style={styles.text}>
              Heart-rate coverage: {formatDurationMinutes(load.coveredSeconds / 60)}
            </Text>
          )}
          {Array.from(maximumsByDate.values(), (maximum) => (
            <Text style={styles.text} key={maximum.date}>
              Maximum heart rate on {formatDateShort(maximum.date, calendarDateOptions)} ·{" "}
              {maximum.bpm} bpm ·{" "}
              {maximum.basis === "profile" ? "Profile" : `Estimated from age ${maximum.age}`}
            </Text>
          ))}
        </View>
      )}
    </View>
  );
}

export function LateWorkoutSleepCard({
  data,
  error,
  isLoading,
  isFetching,
}: LateWorkoutSleepCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [episodeId, setEpisodeId] = useState<string>();
  const nights = [...(data?.nights ?? [])].sort((left, right) => {
    const matchedOrder = Number(right.status === "matched") - Number(left.status === "matched");
    return matchedOrder || right.date.localeCompare(left.date);
  });
  const nightsByDate = new Map<string, LateWorkoutSleepNight[]>();
  for (const night of nights) {
    const sameDate = nightsByDate.get(night.date);
    if (sameDate) sameDate.push(night);
    else nightsByDate.set(night.date, [night]);
  }
  const selected = nights.find((night) => night.episodeId === episodeId) ?? nights[0];
  return (
    <View style={styles.card}>
      <Text accessibilityRole="header" style={styles.title}>
        Late workouts &amp; sleep
      </Text>
      {error && (
        <QueryStatePanel variant="error" message={userFacingErrorMessage(error)} minHeight={56} />
      )}
      {!error && !data && isLoading && (
        <View style={styles.stack} accessibilityState={{ busy: true }}>
          <Text style={styles.muted}>Loading late workout evidence.</Text>
          <QueryStatePanel variant="loading" minHeight={36} />
        </View>
      )}
      {!error && isFetching && (
        <Text accessibilityLiveRegion="polite" style={styles.muted}>
          Refreshing night evidence…
        </Text>
      )}
      {data && (
        <>
          <Text style={styles.muted}>
            {data.range.startDate && data.range.endDate
              ? `${formatDateShort(data.range.startDate, calendarDateOptions)} – ${formatDateMedium(data.range.endDate, calendarDateOptions)} · `
              : null}
            {data.range.timezone}
          </Text>
          {nights.length === 0 ? (
            <QueryStatePanel
              variant="empty"
              message="No nights with sleep evidence in this period."
              minHeight={56}
            />
          ) : (
            <>
              <Text style={styles.text}>
                {data.matchedNightCount} matched {data.matchedNightCount === 1 ? "night" : "nights"}{" "}
                · {data.measuredLoadNightCount} with measured load
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded }}
                onPress={() => setExpanded(!expanded)}
                style={styles.button}
              >
                <Text style={styles.heading}>{expanded ? "Hide nights" : "View nights"}</Text>
              </Pressable>
              {expanded && selected && (
                <>
                  <Text accessibilityRole="header" style={styles.heading}>
                    Compared with your usual sleep onset
                  </Text>
                  <View style={styles.row}>
                    <Text style={styles.muted}>■ Workout finish</Text>
                    <Text style={styles.muted}>● Sleep onset</Text>
                    <Text style={styles.muted}>│ Usual onset</Text>
                  </View>
                  <View style={styles.row}>
                    <Text style={styles.muted}>
                      {formatDurationMinutes(Math.abs(data.axis.lowerMinutes))} earlier
                    </Text>
                    <Text style={styles.muted}>
                      {formatDurationMinutes(Math.abs(data.axis.upperMinutes))} later
                    </Text>
                  </View>
                  <ScrollView
                    nestedScrollEnabled
                    style={styles.nightList}
                    contentContainerStyle={styles.stack}
                  >
                    {nights.map((night) => {
                      const detail = sameDateNightLabel(
                        night,
                        nightsByDate.get(night.date),
                        data.range.timezone,
                      );
                      const loadLabel =
                        night.status !== "matched"
                          ? "Context night"
                          : (night.load.category ?? "Load unavailable");
                      const label = [
                        formatDateLong(night.date, calendarDateOptions),
                        detail,
                        loadLabel,
                      ]
                        .filter(Boolean)
                        .join(", ");
                      return (
                        <Pressable
                          key={night.episodeId}
                          accessibilityRole="button"
                          accessibilityState={{ selected: night === selected }}
                          accessibilityLabel={label}
                          onPress={() => setEpisodeId(night.episodeId)}
                          style={[styles.button, night === selected && styles.selected]}
                        >
                          <View style={styles.row}>
                            <View style={styles.nightDate}>
                              <Text style={styles.heading}>
                                {formatDateShort(night.date, calendarDateOptions)}
                              </Text>
                              {detail && <Text style={styles.muted}>{detail}</Text>}
                            </View>
                            <Text style={[styles.muted, styles.category]}>{loadLabel}</Text>
                          </View>
                          <View
                            style={styles.track}
                            accessibilityElementsHidden
                            importantForAccessibility="no-hide-descendants"
                          >
                            <Svg height={16} width="100%">
                              <Line x1="0%" x2="100%" y1={8} y2={8} stroke={colors.border} />
                              <Line
                                x1={`${data.axis.habitualPosition * 100}%`}
                                x2={`${data.axis.habitualPosition * 100}%`}
                                y1={1}
                                y2={15}
                                stroke={colors.textSecondary}
                              />
                              {night.plot.workoutFinish !== null && (
                                <Rect
                                  x={`${night.plot.workoutFinish * 100}%`}
                                  y={4}
                                  width={8}
                                  height={8}
                                  translateX={-4}
                                  fill={colors.accent}
                                />
                              )}
                              {night.plot.actualOnset !== null && (
                                <Circle
                                  cx={`${night.plot.actualOnset * 100}%`}
                                  cy={8}
                                  r={4}
                                  fill={colors.text}
                                />
                              )}
                            </Svg>
                          </View>
                        </Pressable>
                      );
                    })}
                  </ScrollView>
                  <NightEvidence
                    key={selected.episodeId}
                    night={selected}
                    timezone={data.range.timezone}
                  />
                  <Text accessibilityRole="header" style={styles.heading}>
                    Suggestion from the study
                  </Text>
                  <Text style={styles.text}>
                    In a study of highly active adult WHOOP users, the authors suggested finishing
                    exercise at least four hours before sleep or choosing lighter exercise close to
                    bedtime.
                  </Text>
                  <Pressable
                    accessibilityRole="link"
                    style={styles.button}
                    onPress={() =>
                      void openExternalUrl(
                        "https://doi.org/10.1038/s41467-025-58271-x",
                        "LateWorkoutSleepCard",
                      )
                    }
                  >
                    <Text style={styles.link}>Leota et al., 2025</Text>
                  </Pressable>
                </>
              )}
            </>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: 16, padding: 16, gap: 12 },
  title: { color: colors.text, fontSize: 16, fontWeight: "600" },
  heading: { color: colors.text, fontSize: 14, fontWeight: "600" },
  text: { color: colors.text, fontSize: 14 },
  muted: { color: colors.textSecondary, fontSize: 13 },
  button: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  selected: { borderColor: colors.accent },
  track: { marginHorizontal: 6, overflow: "visible" },
  row: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: 8 },
  readings: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  reading: { minWidth: 100, flexShrink: 1, gap: 2 },
  evidence: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 12, gap: 8 },
  stack: { gap: 6 },
  nightList: { maxHeight: 250 },
  nightDate: { flexShrink: 1 },
  category: { textTransform: "capitalize" },
  link: { color: colors.text, textDecorationLine: "underline" },
});
