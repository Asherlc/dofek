import { formatDateMedium, formatDurationSeconds, formatPace } from "@dofek/format/format";
import { processingPollInterval } from "@dofek/providers/processing-status";
import {
  type GhostSessionsCompareResponse,
  type GhostSessionsGetResponse,
  ghostReplayAtElapsedMs,
} from "@dofek/training/ghost-sessions";
import { type UseQueryResult, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { getQueryKey } from "@trpc/react-query";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { trpc } from "../lib/trpc.ts";
import { useUnitConverter } from "../lib/unitContext.ts";
import { ActivityRouteMap, ghostReplayMarkerColors } from "./ActivityRouteMap.tsx";
import { GHOST_MAP_LABELS_SETTING } from "./GhostMapLabelsSetting.tsx";
import { QueryStatePanel } from "./QueryStatePanel.tsx";

type GhostSection = GhostSessionsGetResponse["sections"][number];
type GhostGetRefresh = Pick<
  UseQueryResult<GhostSessionsGetResponse, unknown>,
  "refetch" | "error" | "isFetching" | "dataUpdatedAt"
>;
const noPoints: [] = [];
const buttonStyle =
  "min-h-11 rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-surface-hover disabled:opacity-50";
const choiceStyle = `${buttonStyle} aria-pressed:border-accent aria-pressed:bg-accent/10`;

function sectionTitle(section: GhostSection) {
  switch (section.kind) {
    case "route":
      return "Full route";
    case "shared-stretch":
      return "Shared stretch";
    case "unnamed-climb":
      return "Unnamed climb";
    default:
      return section.name;
  }
}

function isNamed(section: GhostSection) {
  return section.kind === "named-road" || section.kind === "named-trail";
}

function elapsed(ms: number) {
  return formatDurationSeconds(ms / 1000, { precision: "second" });
}

export function GhostSessions({ activityId }: { activityId: string }) {
  const heading = useId();
  const session = trpc.ghostSessions.get.useQuery(
    { activityId },
    {
      meta: { persist: false },
      refetchInterval: ({ state }) =>
        state.data?.availability === "processing" || state.data?.nameStatus === "processing"
          ? processingPollInterval("active")
          : false,
    },
  );
  if (session.data?.availability === "unavailable") return null;

  return (
    <section aria-labelledby={heading} className="@container card min-w-0 space-y-4 p-3 sm:p-5">
      <h2 id={heading} className="text-xl font-semibold text-foreground">
        Ghost Sessions
      </h2>
      {session.data?.availability === "ready" ? (
        <ReadyGhostSessions activityId={activityId} data={session.data} refresh={session} />
      ) : session.error ? (
        <QueryStatePanel
          title="Ghost Sessions could not be loaded"
          error={session.error}
          height={80}
          onRetry={() => void session.refetch()}
          retrying={session.isFetching}
        />
      ) : (
        <QueryStatePanel
          variant="loading"
          height={80}
          message={session.data ? "Preparing Ghost Sessions." : "Loading Ghost Sessions."}
        />
      )}
    </section>
  );
}

function ReadyGhostSessions({
  activityId,
  data,
  refresh: { refetch, error: refreshError, isFetching, dataUpdatedAt },
}: {
  activityId: string;
  data: GhostSessionsGetResponse;
  refresh: GhostGetRefresh;
}) {
  const queryClient = useQueryClient();
  const consent = trpc.settings.get.useQuery(GHOST_MAP_LABELS_SETTING, {
    enabled: data.nameStatus !== "disabled",
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    // Each successful read supplies a new identity even when the boolean is unchanged.
    structuralSharing: false,
    meta: { persist: false },
  });
  const consentAllowsNames =
    data.nameStatus !== "disabled" && consent.data?.value === true && !consent.isError;
  const liveConsent =
    consentAllowsNames && consent.isFetchedAfterMount && consent.fetchStatus === "idle"
      ? consent.data
      : undefined;
  const [verified, setVerified] = useState<{
    attempt: number;
    consent: NonNullable<typeof liveConsent>;
    data: GhostSessionsGetResponse;
    updatedAt: number;
  }>();
  const [refreshAttempt, setRefreshAttempt] = useState(0);
  useEffect(() => {
    if (!liveConsent) return;
    const key = getQueryKey(trpc.ghostSessions.get, { activityId }, "query");
    const previousUpdateCount = queryClient.getQueryState(key)?.dataUpdateCount ?? 0;
    let current = true;
    // Replace a Get that was still running when the setting resolved.
    void refetch({ cancelRefetch: true, throwOnError: true }).then(
      (result) => {
        const updateCount = queryClient.getQueryState(key)?.dataUpdateCount ?? 0;
        // Cancellation can restore the previous successful result without updating the data.
        if (current && result.isSuccess && updateCount > previousUpdateCount) {
          setVerified({
            attempt: refreshAttempt,
            consent: liveConsent,
            data: result.data,
            updatedAt: result.dataUpdatedAt,
          });
        }
      },
      () => {
        // The Get query reports the refresh error below.
      },
    );
    return () => {
      current = false;
    };
  }, [activityId, liveConsent, queryClient, refetch, refreshAttempt]);
  const retainNamedSelection = consentAllowsNames && !refreshError;
  const showNames =
    retainNamedSelection &&
    !!verified &&
    verified.attempt === refreshAttempt &&
    verified.consent === liveConsent &&
    // The observer may still render the old Get snapshot when the refetch promise resolves.
    (verified.data === data || dataUpdatedAt > verified.updatedAt);
  const [selection, setSelection] = useState<{ sectionId: string; passId?: string }>();
  const sections = data.sections.filter((section) => showNames || !isNamed(section));
  const route = sections.find((section) => section.kind === "route");
  const selected = data.sections.find((section) => section.sectionId === selection?.sectionId);
  const section = (selected && (showNames || !isNamed(selected)) ? selected : route) ?? sections[0];
  if (selection && (!selected || (isNamed(selected) && !retainNamedSelection))) {
    setSelection(undefined);
  }

  return (
    <>
      {section ? (
        <GhostComparison
          key={section.sectionId}
          activityId={activityId}
          section={section}
          contextGeometry={section.kind === "route" ? undefined : route?.geometry}
          historyCoverage={data.historyCoverage}
          pickedPassId={selection?.sectionId === section.sectionId ? selection.passId : undefined}
          onPickPass={(passId) => setSelection({ sectionId: section.sectionId, passId })}
        />
      ) : (
        <p className="text-sm text-muted">No recorded sections are available yet.</p>
      )}
      {sections.length > 1 ? (
        <div className="space-y-2 border-t border-border pt-4">
          <h3 className="text-sm font-semibold text-foreground">Route breakdown</h3>
          <ul className="flex flex-wrap gap-2">
            {sections.map((choice) => (
              <li key={choice.sectionId} className="min-w-0 max-w-full">
                <button
                  type="button"
                  className={`${choiceStyle} max-w-full break-words text-left`}
                  aria-pressed={choice.sectionId === section?.sectionId}
                  onClick={() =>
                    setSelection((current) =>
                      current?.sectionId === choice.sectionId
                        ? current
                        : { sectionId: choice.sectionId },
                    )
                  }
                >
                  {sectionTitle(choice)}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="space-y-1 text-xs text-muted">
        {data.gpsCoverage === "partial" ? <p>Recorded GPS coverage is partial.</p> : null}
        {data.gpsCoverage === "unusable" ? (
          <p>GPS coverage is insufficient for a comparison.</p>
        ) : null}
        {data.historyCoverage === "partial" ? <p>Saved history is partial.</p> : null}
        {showNames && data.nameStatus === "processing" ? (
          <p role="status">Looking up road and trail names…</p>
        ) : null}
        {showNames && data.nameStatus === "unavailable" ? (
          <p>Road and trail names are unavailable.</p>
        ) : null}
        {showNames && data.nameStatus === "error" ? (
          <p>Road and trail names could not be loaded.</p>
        ) : null}
        {showNames && data.mapCoverage === "partial" ? <p>Map name coverage is partial.</p> : null}
      </div>
      {refreshError ? (
        <QueryStatePanel
          title="Ghost Sessions could not be refreshed"
          error={refreshError}
          height={72}
          onRetry={() => {
            if (liveConsent) setRefreshAttempt((attempt) => attempt + 1);
            else void refetch();
          }}
          retrying={isFetching}
        />
      ) : null}
    </>
  );
}

function GhostComparison({
  activityId,
  section,
  contextGeometry,
  historyCoverage,
  pickedPassId,
  onPickPass,
}: {
  activityId: string;
  section: GhostSection;
  contextGeometry: GhostSection["geometry"];
  historyCoverage: GhostSessionsGetResponse["historyCoverage"];
  pickedPassId: string | undefined;
  onPickPass: (passId: string | undefined) => void;
}) {
  const { sectionId, suggestedGhost } = section;
  const [missingPassIds, setMissingPassIds] = useState<string[]>([]);
  const sectionInput = { activityId, sectionId };
  const passes = trpc.ghostSessions.passes.useInfiniteQuery(sectionInput, {
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    meta: { persist: false },
  });
  const items =
    passes.data?.pages.flatMap((page) =>
      page.passes.filter((pass) => !missingPassIds.includes(pass.passId)),
    ) ?? [];
  const passId = [pickedPassId, suggestedGhost?.passId, items[0]?.passId].find(
    (id) => id && !missingPassIds.includes(id),
  );
  const comparison = trpc.ghostSessions.compare.useQuery(
    { activityId, sectionId, passId: passId ?? "" },
    {
      enabled: Boolean(passId),
      meta: { persist: false },
    },
  );
  const utils = trpc.useUtils();
  const passNotFound = comparison.error?.data?.code === "NOT_FOUND";

  useEffect(() => {
    if (!passId || !passNotFound) return;
    setMissingPassIds((previous) => [...previous, passId]);
    if (pickedPassId === passId) onPickPass(undefined);
    void utils.ghostSessions.get.invalidate({ activityId });
    void utils.ghostSessions.passes.invalidate({ activityId, sectionId });
  }, [passId, passNotFound, pickedPassId, onPickPass, activityId, sectionId, utils]);

  const activePass = items.find((pass) => pass.passId === passId);
  const suggestion = !passNotFound && passId === suggestedGhost?.passId ? suggestedGhost : null;
  const measured = passNotFound ? undefined : comparison.data;
  const unavailablePassId = missingPassIds.at(-1);
  const earlierLabel = activePass ? formatDateMedium(activePass.startedAt) : "Ghost";
  const onlyNamed =
    isNamed(section) && !suggestedGhost && !passes.data && passes.error?.data?.code === "NOT_FOUND";
  const passesError = onlyNamed ? null : passes.error;
  const clipped =
    measured &&
    section.anchor &&
    (measured.anchor.start.timestampMs !== section.anchor.start.timestampMs ||
      measured.anchor.end.timestampMs !== section.anchor.end.timestampMs);

  return (
    <div className="grid min-w-0 gap-5 @min-[720px]:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h3 className="min-w-0 break-words text-sm font-semibold text-foreground">
            {sectionTitle(section)}
          </h3>
          {suggestion ? (
            <span className="rounded-md bg-accent/10 px-2 py-1 text-xs text-foreground">
              {suggestion.reason === "previous-best" ? "Previous best" : "Latest comparable pass"}
            </span>
          ) : null}
        </div>
        {measured ? (
          <>
            <Delta elapsedMs={measured.elapsedDifferenceMs} />
            {clipped ? (
              <p className="text-sm text-muted">
                This comparison times the shared portion of the recorded section.
              </p>
            ) : null}
            <GhostReplay
              key={passId}
              comparison={measured}
              geometry={clipped ? undefined : section.geometry}
              contextGeometry={clipped ? (section.geometry ?? contextGeometry) : contextGeometry}
            />
            <ComparisonSummary comparison={measured} earlierLabel={earlierLabel} />
            {comparison.error ? (
              <QueryStatePanel
                title="Comparison could not be refreshed"
                error={comparison.error}
                onRetry={() => void comparison.refetch()}
                height={72}
              />
            ) : null}
          </>
        ) : (
          <>
            {passId && comparison.isPending ? (
              <QueryStatePanel variant="loading" contextLabel="comparison" height={72} />
            ) : null}
            {passId && comparison.error && !passNotFound ? (
              <QueryStatePanel
                title="Comparison could not be loaded"
                error={comparison.error}
                onRetry={() => void comparison.refetch()}
                height={72}
              />
            ) : null}
            {!passId && section.firstVisit && items.length === 0 ? (
              <p className="text-base font-semibold text-foreground">First visit</p>
            ) : null}
            {section.anchor ? (
              <p className="text-sm text-muted">
                {elapsed(section.anchor.elapsedMs)} recorded elapsed
              </p>
            ) : null}
            {section.geometry || contextGeometry ? (
              <ActivityRouteMap
                points={noPoints}
                routeChunks={section.geometry}
                contextChunks={contextGeometry}
              />
            ) : null}
          </>
        )}
        {section.kind === "named-road" || section.kind === "named-trail" ? (
          <p className="text-xs text-muted">
            {section.attribution ?? "Geoapify map labels"}
            {" · "}
            <a className="underline" href="https://www.openstreetmap.org/copyright">
              OpenStreetMap attribution
            </a>
          </p>
        ) : null}
      </div>
      <div className="min-w-0 space-y-2 self-start rounded-lg border border-border p-3">
        <h3 className="text-sm font-semibold text-foreground">Past matches</h3>
        {(isNamed(section) || section.kind === "unnamed-climb") && items.length > 0 ? (
          <p className="text-xs text-muted">Saved history for this section is partial.</p>
        ) : null}
        {passes.isPending ? (
          <QueryStatePanel variant="loading" contextLabel="past matches" height={64} />
        ) : null}
        {passesError ? (
          <QueryStatePanel
            title="Past matches could not be loaded"
            error={passesError}
            onRetry={() => {
              if (passesError.data?.code === "NOT_FOUND" && (passes.data?.pages.length ?? 0) > 0) {
                void utils.ghostSessions.passes.reset(sectionInput);
              } else if (passes.isFetchNextPageError) void passes.fetchNextPage();
              else void passes.refetch();
            }}
            height={64}
          />
        ) : null}
        {onlyNamed || (passes.data && items.length === 0) ? (
          <p className="text-sm text-muted">
            {section.firstVisit
              ? "This is your first recorded visit."
              : historyCoverage === "partial" || section.kind !== "route"
                ? "No earlier comparable pass in the history checked so far."
                : "No earlier comparable pass was found."}
          </p>
        ) : null}
        <ul className="divide-y divide-border">
          {items.map((pass) => {
            const date = formatDateMedium(pass.startedAt);
            return (
              <li
                key={pass.passId}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
              >
                <button
                  type="button"
                  className={`${choiceStyle} min-w-0 text-left`}
                  aria-pressed={passId === pass.passId}
                  onClick={() => onPickPass(pass.passId)}
                >
                  <span className="block">{date}</span>
                  <span className="text-xs text-muted">{elapsed(pass.elapsedMs)}</span>
                </button>
                <Link
                  to="/activity/$id"
                  params={{ id: pass.activityId }}
                  aria-label={`Open ${date} activity`}
                  className="inline-flex min-h-11 items-center px-2 text-xs text-foreground underline"
                >
                  Open activity
                </Link>
              </li>
            );
          })}
        </ul>
        {unavailablePassId ? (
          <button
            type="button"
            className={buttonStyle}
            onClick={() => {
              void utils.ghostSessions.compare.reset({
                ...sectionInput,
                passId: unavailablePassId,
              });
              setMissingPassIds((previous) => previous.filter((id) => id !== unavailablePassId));
              onPickPass(unavailablePassId);
            }}
          >
            Retry unavailable pass
          </button>
        ) : null}
        {passes.hasNextPage ? (
          <button
            type="button"
            className={buttonStyle}
            disabled={passes.isFetching}
            onClick={() => void passes.fetchNextPage()}
          >
            {passes.isFetchingNextPage ? "Loading passes…" : "Load more passes"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function Delta({ elapsedMs }: { elapsedMs: number }) {
  const difference = Math.abs(elapsedMs);
  return (
    <p className="text-xl font-semibold tabular-nums text-foreground">
      {elapsedMs === 0
        ? "Same elapsed time"
        : `${elapsed(difference)} ${elapsedMs < 0 ? "faster" : "slower"}`}
    </p>
  );
}

function ComparisonSummary({
  comparison,
  earlierLabel,
}: {
  comparison: GhostSessionsCompareResponse;
  earlierLabel: string;
}) {
  const units = useUnitConverter();
  const { anchor, candidate, metrics } = comparison;
  const pace = (value: number) => `${formatPace(units.convertPace(value))}${units.paceLabel}`;
  const rows = [
    {
      label: "Elapsed",
      anchor: elapsed(anchor.elapsedMs),
      candidate: elapsed(candidate.elapsedMs),
    },
    ...(metrics.paceSecondsPerKm
      ? [
          {
            label: "Pace",
            anchor: pace(metrics.paceSecondsPerKm.anchor),
            candidate: pace(metrics.paceSecondsPerKm.candidate),
          },
        ]
      : []),
    ...(metrics.heartRateBpm
      ? [
          {
            label: "Average heart rate",
            anchor: `${Math.round(metrics.heartRateBpm.anchor)} bpm`,
            candidate: `${Math.round(metrics.heartRateBpm.candidate)} bpm`,
          },
        ]
      : []),
    ...(metrics.powerWatts
      ? [
          {
            label: "Average power",
            anchor: `${Math.round(metrics.powerWatts.anchor)} W`,
            candidate: `${Math.round(metrics.powerWatts.candidate)} W`,
          },
        ]
      : []),
  ];
  return (
    <>
      <table className="w-full text-left text-sm tabular-nums">
        <caption className="sr-only">Recorded effort comparison</caption>
        <thead className="text-xs text-muted">
          <tr>
            <th scope="col">
              <span className="sr-only">Measure</span>
            </th>
            <th scope="col" className="px-1">
              This activity
            </th>
            <th scope="col" className="px-1">
              {earlierLabel}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr className="border-t border-border" key={row.label}>
              <th scope="row" className="py-2 text-xs font-medium text-muted">
                {row.label}
              </th>
              <td className="px-1 py-2">{row.anchor}</td>
              <td className="px-1 py-2">{row.candidate}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-muted">Elapsed time includes recorded stops.</p>
    </>
  );
}

function GhostReplay({
  comparison,
  geometry,
  contextGeometry,
}: {
  comparison: GhostSessionsCompareResponse;
  geometry: GhostSection["geometry"];
  contextGeometry: GhostSection["geometry"];
}) {
  const { replay, replayDownsampled } = comparison;
  const duration = Math.max(comparison.anchor.elapsedMs, comparison.candidate.elapsedMs);
  const [elapsedMs, setElapsed] = useState(0);
  const [playing, setPlaying] = useState(false);
  const elapsedRef = useRef(0);
  const replayBounds = useMemo(
    () => replay?.flatMap(({ anchor, candidate }) => [anchor, candidate]),
    [replay],
  );

  useEffect(() => {
    if (!playing) return;
    const startMs = elapsedRef.current;
    let firstFrame: number | undefined;
    let frame = requestAnimationFrame(tick);
    function tick(now: number) {
      firstFrame ??= now;
      const next = Math.min(duration, startMs + now - firstFrame);
      elapsedRef.current = next;
      setElapsed(next);
      if (next < duration) frame = requestAnimationFrame(tick);
      else setPlaying(false);
    }
    return () => cancelAnimationFrame(frame);
  }, [playing, duration]);

  function seekTo(time: number) {
    elapsedRef.current = time;
    setElapsed(time);
    setPlaying(false);
  }

  return (
    <>
      {geometry || contextGeometry || replayBounds ? (
        <ActivityRouteMap
          points={noPoints}
          routeChunks={geometry}
          contextChunks={contextGeometry}
          replayBounds={replayBounds}
          replayPositions={ghostReplayAtElapsedMs(replay, elapsedMs)}
        />
      ) : null}
      {replay ? (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-3 text-xs text-muted">
            <span>
              <span
                aria-hidden="true"
                className="mr-1 inline-block h-3 w-3 rounded-full align-middle"
                style={{ backgroundColor: ghostReplayMarkerColors.anchor }}
              />
              This activity
            </span>
            <span>
              <span
                aria-hidden="true"
                className="mr-1 inline-block h-3 w-3 rounded-full border-2 align-middle"
                style={{ borderColor: ghostReplayMarkerColors.candidate }}
              />
              Ghost
            </span>
          </div>
          <label className="flex min-h-11 items-center gap-2 text-xs text-muted">
            <span className="sr-only">Replay elapsed time</span>
            <input
              type="range"
              className="min-w-0 flex-1 accent-accent"
              min={0}
              max={duration}
              step="any"
              value={Math.min(elapsedMs, duration)}
              aria-valuetext={`${elapsed(elapsedMs)} of ${elapsed(duration)}`}
              onChange={(event) => seekTo(event.currentTarget.valueAsNumber)}
            />
            <span aria-hidden="true" className="tabular-nums">
              {elapsed(elapsedMs)} / {elapsed(duration)}
            </span>
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonStyle}
              onClick={() => {
                if (elapsedMs >= duration) seekTo(0);
                setPlaying(!playing);
              }}
            >
              {playing ? "Pause replay" : "Play replay"}
            </button>
            <button type="button" className={buttonStyle} onClick={() => seekTo(0)}>
              Restart replay
            </button>
          </div>
          {replayDownsampled ? (
            <p className="text-xs text-muted">Replay uses a subset of recorded positions.</p>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted">Map replay is unavailable for this comparison.</p>
      )}
    </>
  );
}
