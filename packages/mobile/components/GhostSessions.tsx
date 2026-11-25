import { formatDateMedium, formatDurationSeconds, formatPace } from "@dofek/format/format";
import { chartColors } from "@dofek/scoring/colors";
import {
  type GhostSessionsCompareResponse,
  type GhostSessionsGetResponse,
  ghostReplayAtElapsedMs,
} from "@dofek/training/ghost-sessions";
import Slider from "@react-native-community/slider";
import { skipToken, useQueryClient } from "@tanstack/react-query";
import { getQueryKey } from "@trpc/react-query";
import { useRouter } from "expo-router";
import { type ComponentProps, useEffect, useMemo, useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { captureException } from "../lib/telemetry";
import { trpc } from "../lib/trpc";
import { useUnitConverter } from "../lib/units";
import { colors, radius, spacing } from "../theme";
import { getQueryErrorMessage, QueryStatePanel } from "./QueryStatePanel";
import { RouteMap } from "./RouteMap";

type Section = GhostSessionsGetResponse["sections"][number];
type Selection = { sectionId: string; passId: string };
type SectionChoice = { id: string; named: boolean };
const emptyPoints: ComponentProps<typeof RouteMap>["points"] = [];
const noSegments: NonNullable<ComponentProps<typeof RouteMap>["comparison"]>["anchor"] = [];
const privateQuery = {
  meta: { persist: false },
  staleTime: 0,
  refetchOnMount: "always",
  refetchOnWindowFocus: true,
} as const;
const mapCopyrightUrl = "https://www.openstreetmap.org/copyright";
const previewSectionLimit = 6;

function elapsedLabel(ms: number) {
  return formatDurationSeconds(ms / 1_000, { precision: "second" });
}

function sectionLabel(section: Section): string {
  if ("name" in section) return section.name;
  if (section.kind === "route") return "Full route";
  if (section.kind === "unnamed-climb") return "Unnamed climb";
  return "Shared stretch";
}

function Replay({ comparison }: { comparison: GhostSessionsCompareResponse }) {
  const duration = Math.max(comparison.anchor.elapsedMs, comparison.candidate.elapsedMs);
  const [elapsed, setElapsed] = useState(0);
  const [playing, setPlaying] = useState(false);
  const running = playing && elapsed < duration;
  const { replay } = comparison;
  const tracks = useMemo(
    () => ({
      anchor: replay ? [replay.map(({ anchor }) => anchor)] : noSegments,
      candidate: replay ? [replay.map(({ candidate }) => candidate)] : noSegments,
    }),
    [replay],
  );

  useEffect(() => {
    if (!running) return;
    let last = Date.now();
    const tick = setInterval(() => {
      const now = Date.now();
      const delta = now - last;
      last = now;
      setElapsed((value) => Math.min(duration, value + delta));
    }, 50);
    return () => clearInterval(tick);
  }, [duration, running]);

  if (!replay) return <Text style={styles.note}>Replay unavailable for this comparison.</Text>;
  return (
    <View style={styles.group}>
      <RouteMap
        points={emptyPoints}
        height={200}
        comparison={{ ...tracks, positions: ghostReplayAtElapsedMs(replay, elapsed) }}
      />
      <View style={styles.row}>
        <Text style={styles.current}>● Current effort</Text>
        <Text style={styles.prior}>● Past effort</Text>
      </View>
      <Slider
        accessibilityLabel="Replay elapsed time"
        accessibilityValue={{ min: 0, max: duration, now: elapsed, text: elapsedLabel(elapsed) }}
        minimumValue={0}
        maximumValue={duration}
        value={elapsed}
        onValueChange={(value) => {
          setPlaying(false);
          setElapsed(value);
        }}
        minimumTrackTintColor={chartColors.green}
      />
      <View style={styles.row}>
        <Pressable
          style={styles.control}
          accessibilityRole="button"
          onPress={() => {
            if (elapsed >= duration) setElapsed(0);
            setPlaying(!running);
          }}
        >
          <Text style={styles.controlLabel}>{running ? "Pause replay" : "Play replay"}</Text>
        </Pressable>
        <Pressable
          style={styles.control}
          accessibilityRole="button"
          onPress={() => {
            setPlaying(false);
            setElapsed(0);
          }}
        >
          <Text style={styles.controlLabel}>Restart replay</Text>
        </Pressable>
        <Text style={styles.note}>
          {elapsedLabel(elapsed)} / {elapsedLabel(duration)}
        </Text>
      </View>
    </View>
  );
}

function ComparisonSummary({
  comparison,
  section,
}: {
  comparison: GhostSessionsCompareResponse;
  section: Section;
}) {
  const units = useUnitConverter();
  const { anchor, candidate, elapsedDifferenceMs, metrics } = comparison;
  const clipped =
    section.anchor &&
    (section.anchor.start.timestampMs !== anchor.start.timestampMs ||
      section.anchor.end.timestampMs !== anchor.end.timestampMs);
  const pace = metrics.paceSecondsPerKm;
  const heartRate = metrics.heartRateBpm;
  const power = metrics.powerWatts;
  const result =
    elapsedDifferenceMs === 0
      ? "Same elapsed time"
      : `${elapsedLabel(Math.abs(elapsedDifferenceMs))} ${elapsedDifferenceMs < 0 ? "faster" : "slower"}`;
  return (
    <View style={styles.group}>
      <Text style={styles.result}>{result}</Text>
      <View style={styles.row}>
        <Text style={styles.value}>Current · {elapsedLabel(anchor.elapsedMs)}</Text>
        <Text style={styles.value}>Past · {elapsedLabel(candidate.elapsedMs)}</Text>
      </View>
      <Text style={styles.note}>Elapsed time includes recorded stops.</Text>
      {clipped ? <Text style={styles.note}>Only the recorded overlap is compared.</Text> : null}
      {pace ? (
        <Text style={styles.note}>
          <Text style={styles.value}>Pace {units.paceLabel}</Text>
          {` · ${formatPace(units.convertPace(pace.anchor))} / ${formatPace(units.convertPace(pace.candidate))}`}
        </Text>
      ) : null}
      {heartRate ? (
        <Text style={styles.note}>
          Heart rate · {Math.round(heartRate.anchor)} / {Math.round(heartRate.candidate)} bpm
        </Text>
      ) : null}
      {power ? (
        <Text style={styles.note}>
          Power · {Math.round(power.anchor)} / {Math.round(power.candidate)} W
        </Text>
      ) : null}
      {!heartRate && !power ? (
        <Text style={styles.note}>Heart rate and power are unavailable for this comparison.</Text>
      ) : null}
    </View>
  );
}

function mapNameMessage(detail: GhostSessionsGetResponse) {
  if (detail.nameStatus === "error") return "Road and trail names are temporarily unavailable.";
  if (detail.nameStatus === "processing") return "Road and trail names are processing.";
  if (detail.mapCoverage === "partial") return "Partial map coverage.";
  if (detail.nameStatus === "unavailable")
    return "Map coverage is insufficient for road or trail names.";
  return null;
}

export function GhostSessions({ activityId }: { activityId: string }) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();
  const labelSetting = trpc.settings.get.useQuery(
    { key: "ghostMapLabels" },
    { ...privateQuery, structuralSharing: false },
  );
  const labelCheckPending = labelSetting.isFetching || labelSetting.fetchStatus === "paused";
  const labelConsentDenied =
    Boolean(labelSetting.error) ||
    (labelSetting.data !== undefined && labelSetting.data?.value !== true);
  const optIn = !labelConsentDenied && labelSetting.data?.value === true ? labelSetting.data : null;
  const consentReceipt = !labelCheckPending && labelSetting.isFetchedAfterMount ? optIn : null;
  const detailQuery = trpc.ghostSessions.get.useQuery(
    { activityId },
    {
      ...privateQuery,
      refetchOnMount: optIn ? false : "always",
      refetchOnWindowFocus: !optIn,
      refetchInterval: ({ state }) =>
        state.data?.availability === "processing" || state.data?.nameStatus === "processing"
          ? 5_000
          : false,
    },
  );
  const [verifiedLabels, setVerifiedLabels] = useState<{
    activityId: string;
    consentReceipt: NonNullable<typeof consentReceipt>;
    detail: GhostSessionsGetResponse;
    detailUpdatedAt: number;
  } | null>(null);
  const refreshDetail = detailQuery.refetch;
  useEffect(() => {
    if (!consentReceipt) {
      setVerifiedLabels(null);
      return;
    }
    const receipt = consentReceipt;
    let current = true;
    async function verifyLabels() {
      // A pre-consent Get may have captured an earlier label revision.
      await utils.ghostSessions.get.cancel({ activityId });
      if (!current) return;
      const detailKey = getQueryKey(trpc.ghostSessions.get, { activityId }, "query");
      const previousUpdateCount = queryClient.getQueryState(detailKey)?.dataUpdateCount ?? 0;
      const result = await refreshDetail({ cancelRefetch: false });
      // A canceled refetch can report success with restored cache data.
      const currentUpdateCount = queryClient.getQueryState(detailKey)?.dataUpdateCount ?? 0;
      if (current && result.isSuccess && result.data && currentUpdateCount > previousUpdateCount) {
        setVerifiedLabels({
          activityId,
          consentReceipt: receipt,
          detail: result.data,
          detailUpdatedAt: result.dataUpdatedAt,
        });
      }
    }
    void verifyLabels().catch((error: unknown) =>
      captureException(error, { context: "ghost-labels-refresh" }),
    );
    return () => {
      current = false;
    };
  }, [activityId, consentReceipt, queryClient, refreshDetail, utils]);
  const labelsAllowed =
    consentReceipt != null &&
    verifiedLabels?.activityId === activityId &&
    verifiedLabels.consentReceipt === consentReceipt &&
    (detailQuery.data === verifiedLabels.detail ||
      detailQuery.dataUpdatedAt > verifiedLabels.detailUpdatedAt);
  const detail = detailQuery.data;
  const sections =
    detail?.availability === "ready"
      ? detail.sections.filter((section) => labelsAllowed || !("name" in section))
      : [];
  const [chosenSection, setChosenSection] = useState<SectionChoice | null>(null);
  const [manual, setManual] = useState<Selection | null>(null);
  const [rejected, setRejected] = useState<Selection[]>([]);
  const [showPasses, setShowPasses] = useState(false);
  const [showSections, setShowSections] = useState(false);
  const section = sections.find((option) => option.sectionId === chosenSection?.id) ?? sections[0];
  const staleIds = rejected
    .filter((item) => item.sectionId === section?.sectionId)
    .map(({ passId }) => passId);
  const passesQuery = trpc.ghostSessions.passes.useInfiniteQuery(
    section ? { activityId, sectionId: section.sectionId } : skipToken,
    {
      ...privateQuery,
      enabled: Boolean(section && !section.firstVisit) && (showPasses || staleIds.length > 0),
      getNextPageParam: (page) => page.nextCursor ?? undefined,
    },
  );
  const passes =
    passesQuery.data?.pages
      .flatMap((page) => page.passes)
      .filter(({ passId }) => !staleIds.includes(passId)) ?? [];
  const manualPassId = manual?.sectionId === section?.sectionId ? manual?.passId : undefined;
  const suggestion = section?.suggestedGhost;
  const passId = section?.firstVisit
    ? undefined
    : [manualPassId, suggestion?.passId, staleIds.length > 0 ? passes[0]?.passId : undefined].find(
        (pass) => pass && !staleIds.includes(pass),
      );
  const comparisonQuery = trpc.ghostSessions.compare.useQuery(
    section && passId ? { activityId, sectionId: section.sectionId, passId } : skipToken,
    { ...privateQuery, retry: (count, error) => error.data?.code !== "NOT_FOUND" && count < 2 },
  );
  const unavailablePass = comparisonQuery.error?.data?.code === "NOT_FOUND";
  const activeSectionId = section?.sectionId;
  const waitingForChosenName =
    chosenSection?.named === true && !labelConsentDenied && !labelsAllowed;
  const chosenNameDenied = chosenSection?.named === true && labelConsentDenied;
  useEffect(() => {
    if (!unavailablePass || !activeSectionId || !passId) return;
    setRejected((previous) => [...previous, { sectionId: activeSectionId, passId }]);
  }, [activeSectionId, passId, unavailablePass]);

  useEffect(() => {
    if (
      !chosenSection ||
      waitingForChosenName ||
      (!chosenNameDenied &&
        (detail?.availability !== "ready" || chosenSection.id === activeSectionId))
    )
      return;
    setChosenSection(null);
    setManual(null);
    setShowPasses(false);
  }, [
    activeSectionId,
    chosenNameDenied,
    chosenSection,
    detail?.availability,
    waitingForChosenName,
  ]);

  if (detail?.availability === "unavailable") return null;
  const comparison = unavailablePass ? undefined : comparisonQuery.data;
  const mapMessage = detail && labelsAllowed ? mapNameMessage(detail) : null;
  const replacementError = !passId && staleIds.length > 0 ? passesQuery.error : null;
  return (
    <View style={styles.panel}>
      <Text style={styles.heading} accessibilityRole="header">
        Ghost Sessions
      </Text>
      {!detail && detailQuery.error ? (
        <QueryStatePanel
          variant="error"
          message={getQueryErrorMessage(detailQuery.error, "Could not load Ghost Sessions.")}
          onRetry={() => void detailQuery.refetch()}
        />
      ) : !detail || detail.availability === "processing" ? (
        <>
          <QueryStatePanel variant="loading" minHeight={64} />
          <Text style={styles.note}>Preparing recorded route comparisons…</Text>
        </>
      ) : (
        <>
          {detail.historyCoverage === "partial" && (
            <Text style={styles.note}>History is incomplete.</Text>
          )}
          {mapMessage && <Text style={styles.note}>{mapMessage}</Text>}
          {section ? (
            <>
              <Text style={styles.subtitle}>{sectionLabel(section)}</Text>
              {"name" in section && section.attribution ? (
                <Pressable
                  accessibilityRole="link"
                  accessibilityLabel="OpenStreetMap copyright"
                  onPress={() =>
                    void Linking.openURL(mapCopyrightUrl).catch((error: unknown) =>
                      captureException(error, { context: "ghost-map-attribution" }),
                    )
                  }
                >
                  <Text style={styles.link}>{section.attribution}</Text>
                </Pressable>
              ) : null}
              {comparison && passId ? (
                <>
                  {suggestion?.passId === passId && (
                    <Text style={styles.note}>
                      {suggestion.reason === "previous-best" ? "Previous best" : "Most recent"}
                    </Text>
                  )}
                  <ComparisonSummary comparison={comparison} section={section} />
                  <Replay key={`${section.sectionId}:${passId}`} comparison={comparison} />
                </>
              ) : passId && !unavailablePass && comparisonQuery.error ? (
                <QueryStatePanel
                  variant="error"
                  message={getQueryErrorMessage(comparisonQuery.error)}
                  onRetry={() => void comparisonQuery.refetch()}
                />
              ) : replacementError ? (
                <QueryStatePanel
                  variant="error"
                  message={getQueryErrorMessage(replacementError)}
                  onRetry={() => void passesQuery.refetch()}
                />
              ) : passId || (staleIds.length > 0 && passesQuery.isLoading) ? (
                <QueryStatePanel variant="loading" minHeight={64} />
              ) : (
                <>
                  <Text style={styles.value}>
                    {section.firstVisit
                      ? "First recorded visit"
                      : "No earlier comparable effort is available."}
                  </Text>
                  {section.anchor && (
                    <Text style={styles.note}>
                      Recorded time · {elapsedLabel(section.anchor.elapsedMs)}
                    </Text>
                  )}
                  {section.geometry && (
                    <RouteMap
                      points={emptyPoints}
                      height={200}
                      comparison={{ anchor: section.geometry, candidate: noSegments }}
                    />
                  )}
                </>
              )}
              {!section.firstVisit && (
                <Pressable
                  style={styles.control}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: showPasses }}
                  onPress={() => setShowPasses(!showPasses)}
                >
                  <Text style={styles.controlLabel}>Past efforts</Text>
                </Pressable>
              )}
              {showPasses && !section.firstVisit && (
                <View style={styles.group}>
                  {passes.map((pass) => {
                    const date = formatDateMedium(pass.startedAt);
                    const time = elapsedLabel(pass.elapsedMs);
                    return (
                      <View key={pass.passId} style={styles.row}>
                        <Pressable
                          style={styles.control}
                          accessibilityRole="button"
                          accessibilityLabel={`Compare ${date}, ${time}`}
                          accessibilityState={{ selected: passId === pass.passId }}
                          onPress={() =>
                            setManual({ sectionId: section.sectionId, passId: pass.passId })
                          }
                        >
                          <Text style={styles.controlLabel}>
                            {date} · {time}
                          </Text>
                        </Pressable>
                        <Pressable
                          style={styles.control}
                          accessibilityRole="link"
                          accessibilityLabel={`Open workout from ${date}`}
                          onPress={() =>
                            router.push({
                              pathname: "/activity/[id]",
                              params: { id: pass.activityId },
                            })
                          }
                        >
                          <Text style={styles.link}>Open workout</Text>
                        </Pressable>
                      </View>
                    );
                  })}
                  {passesQuery.error && !replacementError ? (
                    <QueryStatePanel
                      variant="error"
                      message={getQueryErrorMessage(passesQuery.error)}
                      onRetry={() => void passesQuery.refetch()}
                    />
                  ) : null}
                  {passesQuery.isLoading && <QueryStatePanel variant="loading" minHeight={48} />}
                  {passesQuery.hasNextPage && (
                    <Pressable
                      style={styles.control}
                      accessibilityRole="button"
                      disabled={passesQuery.isFetchingNextPage}
                      onPress={() => void passesQuery.fetchNextPage()}
                    >
                      <Text style={styles.controlLabel}>Load more past efforts</Text>
                    </Pressable>
                  )}
                </View>
              )}
            </>
          ) : (
            <Text style={styles.note}>No recorded route section is available.</Text>
          )}
          {sections.length > 1 && (
            <View style={styles.row}>
              {(showSections ? sections : sections.slice(0, previewSectionLimit)).map((option) => (
                <Pressable
                  key={option.sectionId}
                  style={[styles.control, option.sectionId === section?.sectionId && styles.active]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: option.sectionId === section?.sectionId }}
                  onPress={() => {
                    setChosenSection({ id: option.sectionId, named: "name" in option });
                    setManual(null);
                    setRejected([]);
                    setShowPasses(false);
                  }}
                >
                  <Text style={styles.controlLabel}>{sectionLabel(option)}</Text>
                </Pressable>
              ))}
              {sections.length > previewSectionLimit && (
                <Pressable
                  style={styles.control}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: showSections }}
                  onPress={() => setShowSections(!showSections)}
                >
                  <Text style={styles.controlLabel}>
                    {showSections ? "Show fewer sections" : `Show all ${sections.length} sections`}
                  </Text>
                </Pressable>
              )}
            </View>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    borderRadius: radius.xl,
    backgroundColor: colors.surface,
    padding: spacing.md,
    gap: spacing.sm,
  },
  group: { gap: spacing.sm },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: spacing.sm },
  heading: { color: colors.text, fontSize: 18, fontWeight: "700" },
  subtitle: { color: colors.text, fontSize: 16, fontWeight: "600" },
  result: { color: colors.text, fontSize: 22, fontWeight: "700" },
  value: { color: colors.text, fontSize: 14, fontWeight: "600" },
  note: { color: colors.textSecondary, fontSize: 13 },
  control: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: spacing.sm,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
  },
  controlLabel: { color: colors.text, fontWeight: "600" },
  active: { borderColor: colors.accent, borderWidth: 1 },
  link: { color: colors.accent, textDecorationLine: "underline" },
  current: { color: chartColors.green, fontWeight: "600" },
  prior: { color: chartColors.blue, fontWeight: "600" },
});
