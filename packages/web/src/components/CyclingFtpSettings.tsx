import {
  formatDateMedium,
  formatDurationSeconds,
  formatNumber,
  shiftDateYmd,
} from "@dofek/format/format";
import { userFacingErrorMessage } from "@dofek/format/user-facing-error";
import { useEffect, useRef, useState } from "react";
import { useTodayQueryDate } from "../hooks/useTodayQueryDate.ts";
import { captureException } from "../lib/telemetry.ts";
import { trpc } from "../lib/trpc.ts";

interface CyclingFtpSettingsProps {
  sectionDate?: string | null;
  focusSection?: boolean;
}

export function CyclingFtpSettings({ sectionDate, focusSection = false }: CyclingFtpSettingsProps) {
  const utils = trpc.useUtils();
  const today = useTodayQueryDate();
  const [effectiveDate, setEffectiveDate] = useState(() => sectionDate ?? today);
  const [inputValue, setInputValue] = useState("");
  const [isDirty, setIsDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [estimateError, setEstimateError] = useState<string | null>(null);
  const [isEstimating, setIsEstimating] = useState(false);
  const [startDate, setStartDate] = useState(() => shiftDateYmd(sectionDate ?? today, -89));
  const [endDate, setEndDate] = useState(() => sectionDate ?? today);
  const ftpInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (sectionDate) {
      setEffectiveDate(sectionDate);
      setIsDirty(false);
    }
  }, [sectionDate]);

  const settingsQuery = trpc.sportSettings.getBySport.useQuery({
    sport: "cycling",
    asOfDate: effectiveDate,
  });
  useEffect(() => {
    if (focusSection && !settingsQuery.isLoading && !settingsQuery.error) {
      ftpInput.current?.focus();
    }
  }, [focusSection, settingsQuery.error, settingsQuery.isLoading]);
  const historyQuery = trpc.sportSettings.history.useQuery({ sport: "cycling" });
  const upsertMutation = trpc.sportSettings.upsert.useMutation({
    onSuccess: (saved, variables) => {
      const savedDate = variables.effectiveFrom ?? saved.effectiveFrom;
      utils.sportSettings.getBySport.setData({ sport: "cycling", asOfDate: savedDate }, saved);
      if (effectiveDate === savedDate) {
        setInputValue(saved.ftp == null ? "" : String(saved.ftp));
        setIsDirty(false);
      }
      setError(null);
      setIsEstimating(false);
      void utils.sportSettings.getBySport.invalidate();
      void utils.sportSettings.history.invalidate();
      void utils.activity.powerZones.invalidate();
      void utils.cycling.invalidate();
      void utils.pmc.invalidate();
      void utils.calendar.invalidate();
    },
    onError: (writeError) => {
      setError(userFacingErrorMessage(writeError));
      captureException(writeError, { context: "cycling-ftp-save" });
    },
  });
  const suggestionsQuery = trpc.power.ftpSuggestions.useQuery(
    { start_date: startDate, end_date: endDate },
    { enabled: false },
  );

  useEffect(() => {
    if (isDirty || settingsQuery.isLoading || settingsQuery.error) return;
    setInputValue(settingsQuery.data?.ftp == null ? "" : String(settingsQuery.data.ftp));
  }, [isDirty, settingsQuery.data, settingsQuery.error, settingsQuery.isLoading]);

  useEffect(() => {
    setStartDate(shiftDateYmd(effectiveDate, -89));
    setEndDate(effectiveDate);
    setIsEstimating(false);
    setEstimateError(null);
  }, [effectiveDate]);

  const savedFtp = settingsQuery.data?.ftp ?? null;
  const appliedFrom = settingsQuery.data?.effectiveFrom ?? null;
  const savedDates = historyQuery.data ?? [];

  function handleSave() {
    const ftp = parseWholeWatt(inputValue);
    if (ftp === null) {
      setError("Enter a positive whole number for FTP (watts).");
      return;
    }
    setError(null);
    upsertMutation.mutate({ sport: "cycling", ftp, effectiveFrom: effectiveDate });
  }

  function handleClear() {
    setError(null);
    upsertMutation.mutate({ sport: "cycling", ftp: null, effectiveFrom: effectiveDate });
  }

  function handleEstimate() {
    if (!isDateYmd(startDate) || !isDateYmd(endDate) || startDate > endDate) {
      setEstimateError("Choose a valid start date on or before the end date.");
      return;
    }
    setEstimateError(null);
    setIsEstimating(true);
    void suggestionsQuery.refetch().catch((queryError: unknown) => {
      captureException(queryError, { context: "cycling-ftp-suggestions" });
    });
  }

  function handleEffectiveDateChange(value: string) {
    if (!isDateYmd(value)) return;
    setIsDirty(false);
    setEffectiveDate(value);
    setError(null);
  }

  if (settingsQuery.isLoading && !settingsQuery.data) {
    return (
      <p role="status" aria-busy="true">
        Loading FTP settings…
      </p>
    );
  }

  if (settingsQuery.error && !settingsQuery.data) {
    return <p role="alert">{userFacingErrorMessage(settingsQuery.error)}</p>;
  }

  return (
    <div id="cycling-ftp" className="space-y-4">
      {settingsQuery.error ? (
        <p role="alert">{userFacingErrorMessage(settingsQuery.error)}</p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1 text-sm">
          <span className="text-muted">Effective date</span>
          <input
            type="date"
            aria-label="Effective date"
            value={effectiveDate}
            onChange={(event) => handleEffectiveDateChange(event.target.value)}
            disabled={upsertMutation.isPending}
            className={formInputClass}
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="text-muted">Saved FTP dates</span>
          <select
            aria-label="Saved FTP dates"
            value=""
            onChange={(event) => handleEffectiveDateChange(event.target.value)}
            disabled={upsertMutation.isPending || historyQuery.isLoading}
            className={formInputClass}
          >
            <option value="">Choose a saved date</option>
            {savedDates.map((entry) => (
              <option key={entry.effectiveFrom} value={entry.effectiveFrom}>
                {formatDateMedium(entry.effectiveFrom)} —{" "}
                {entry.ftp == null ? "cleared" : `${formatNumber(entry.ftp, 0)} W`}
              </option>
            ))}
          </select>
        </label>
      </div>
      {historyQuery.error ? (
        <p role="alert">
          Saved FTP history could not be loaded: {userFacingErrorMessage(historyQuery.error)}
        </p>
      ) : null}

      <div className="space-y-1 text-sm">
        <label className="block space-y-1" htmlFor="cycling-ftp-input">
          <span className="text-muted">FTP (watts)</span>
          <input
            id="cycling-ftp-input"
            type="number"
            ref={ftpInput}
            aria-label="FTP watts"
            value={inputValue}
            onChange={(event) => {
              setInputValue(event.target.value);
              setIsDirty(true);
            }}
            placeholder="Whole watts"
            min={1}
            step={1}
            disabled={upsertMutation.isPending}
            className={formInputClass}
          />
        </label>
        {savedFtp != null ? (
          <p className="text-xs text-muted">
            {formatNumber(savedFtp, 0)} W applies on {formatDateMedium(effectiveDate)}
            {appliedFrom ? ` (setting effective ${formatDateMedium(appliedFrom)})` : ""}.
          </p>
        ) : (
          <p className="text-xs text-muted">No FTP is set for this date.</p>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={handleEstimate}
          disabled={upsertMutation.isPending}
          className={buttonClass}
        >
          Estimate
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={upsertMutation.isPending || settingsQuery.isLoading}
          className={buttonClass}
        >
          Save
        </button>
        <button
          type="button"
          onClick={handleClear}
          disabled={upsertMutation.isPending || settingsQuery.isLoading}
          className={secondaryButtonClass}
        >
          Clear
        </button>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      ) : null}

      {isEstimating ? (
        <section
          aria-label="FTP suggestions"
          className="space-y-3 rounded-md border border-border/70 bg-surface/30 p-3 text-sm"
        >
          <h3 className="font-medium">
            Suggestions for {formatDateMedium(startDate)} to {formatDateMedium(endDate)}
          </h3>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="space-y-1">
              <span className="text-muted">Start date</span>
              <input
                type="date"
                aria-label="Start date"
                value={startDate}
                onChange={(event) => setStartDate(event.target.value)}
                className={formInputClass}
              />
            </label>
            <label className="space-y-1">
              <span className="text-muted">End date</span>
              <input
                type="date"
                aria-label="End date"
                value={endDate}
                onChange={(event) => setEndDate(event.target.value)}
                className={formInputClass}
              />
            </label>
          </div>
          <p className="text-xs text-muted">
            Recent evidence is limited to the selected dates (90 days by default). Ordinary rides
            may not be maximal; easy-only riding can underestimate FTP.
          </p>
          {estimateError ? <p role="alert">{estimateError}</p> : null}
          <p aria-busy={suggestionsQuery.isFetching} role="status" className="min-h-6 text-muted">
            {suggestionsQuery.isFetching ? "Estimating from recorded activities…" : null}
          </p>
          {suggestionsQuery.error ? (
            <p role="alert" className="text-red-400">
              {userFacingErrorMessage(suggestionsQuery.error)}
            </p>
          ) : null}
          {suggestionsQuery.data ? (
            <div className="space-y-2">
              {suggestionsQuery.data.methods.map((method) => (
                <article
                  key={method.method}
                  className="space-y-1 rounded border border-border/60 p-3"
                >
                  <h4 className="font-medium">{methodLabel(method.method)}</h4>
                  {method.suggested_ftp != null ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <span>Suggested {formatNumber(method.suggested_ftp, 0)} W</span>
                      <button
                        type="button"
                        disabled={upsertMutation.isPending}
                        onClick={() => {
                          setInputValue(String(method.suggested_ftp));
                          setIsDirty(true);
                        }}
                        className={secondaryButtonClass}
                      >
                        Use this value
                      </button>
                    </div>
                  ) : (
                    <p className="text-muted">
                      Unavailable: {method.unavailable_reason ?? "No supported evidence."}
                    </p>
                  )}
                  {method.evidence ? (
                    <p className="text-xs text-muted">
                      Evidence: {method.evidence.activity_name ?? "Ride"} on{" "}
                      {formatDateMedium(method.evidence.date)} —{" "}
                      {formatDurationSeconds(method.evidence.duration_seconds)} at{" "}
                      {formatNumber(method.evidence.power_watts, 0)} W.
                    </p>
                  ) : null}
                  <p className="text-xs text-muted">{method.limitations}</p>
                </article>
              ))}
            </div>
          ) : null}
          {!suggestionsQuery.data && !suggestionsQuery.isFetching && !suggestionsQuery.error ? (
            <p role="status" className="text-muted">
              Select Estimate again after changing the dates to refresh suggestions.
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function parseWholeWatt(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function isDateYmd(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function methodLabel(method: string): string {
  return method === "reference_curves" ? "Reference curves" : "95% of 20-minute best";
}

const buttonClass =
  "text-xs font-medium text-accent hover:text-accent-secondary border border-accent rounded px-3 py-1.5 transition-colors cursor-pointer disabled:opacity-50";
const secondaryButtonClass =
  "text-xs text-muted hover:text-foreground border border-border-strong rounded px-3 py-1.5 transition-colors cursor-pointer disabled:opacity-50";
const formInputClass =
  "w-full rounded bg-surface border border-border px-2 py-1 text-sm focus-visible:outline-2 focus-visible:outline-accent";
