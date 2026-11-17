import {
  formatDateLong,
  formatDateYmd,
  formatDurationSeconds,
  formatNumber,
  shiftDateYmd,
} from "@dofek/format/format";
import { userFacingErrorMessage } from "@dofek/format/user-facing-error";
import DateTimePicker from "@react-native-community/datetimepicker";
import { type ElementRef, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Text, TextInput, TouchableOpacity, View } from "react-native";
import { captureException } from "../lib/telemetry";
import { trpc } from "../lib/trpc";
import { useTodayQueryDate } from "../lib/useTodayQueryDate";
import { colors } from "../theme";

function localDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year ?? 0, (month ?? 1) - 1, day ?? 1, 12);
}

function isDateYmd(value: string): boolean {
  const date = localDate(value);
  return Number.isFinite(date.getTime()) && formatDateYmd(date) === value;
}

function wholePositiveWatts(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const watts = Number(value);
  return Number.isSafeInteger(watts) ? watts : null;
}

function methodLabel(method: string): string {
  return method === "reference_curves" ? "Reference curves" : "95% of best 20 minutes";
}

export function CyclingFtpSettings({
  sectionDate,
  focusSection = false,
}: {
  sectionDate?: string;
  focusSection?: boolean;
}) {
  const utils = trpc.useUtils();
  const today = useTodayQueryDate();
  const initialDate = sectionDate && isDateYmd(sectionDate) ? sectionDate : today;
  const [effectiveDate, setEffectiveDate] = useState(initialDate);
  const [inputValue, setInputValue] = useState("");
  const [isDirty, setIsDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isEstimating, setIsEstimating] = useState(false);
  const [startDate, setStartDate] = useState(shiftDateYmd(initialDate, -89));
  const [endDate, setEndDate] = useState(initialDate);
  const inputRef = useRef<ElementRef<typeof TextInput>>(null);
  const settings = trpc.sportSettings.getBySport.useQuery({
    sport: "cycling",
    asOfDate: effectiveDate,
  });
  const history = trpc.sportSettings.history.useQuery({ sport: "cycling" });
  const suggestions = trpc.power.ftpSuggestions.useQuery(
    { start_date: startDate, end_date: endDate },
    { enabled: false },
  );
  const save = trpc.sportSettings.upsert.useMutation({
    onSuccess: (saved, variables) => {
      const savedDate = variables.effectiveFrom ?? saved.effectiveFrom;
      utils.sportSettings.getBySport.setData({ sport: "cycling", asOfDate: savedDate }, saved);
      if (effectiveDate === savedDate) {
        setInputValue(saved.ftp == null ? "" : String(saved.ftp));
        setIsDirty(false);
      }
      setError(null);
      void utils.sportSettings.getBySport.invalidate(undefined, { refetchType: "all" });
      void utils.sportSettings.history.invalidate(undefined, { refetchType: "all" });
      void utils.activity.powerZones.invalidate(undefined, { refetchType: "all" });
      void utils.calendar.weekListV2.invalidate(undefined, { refetchType: "all" });
    },
    onError: (writeError) => {
      setError(userFacingErrorMessage(writeError));
      captureException(writeError, { source: "cycling-ftp-save" });
    },
  });

  useEffect(() => {
    if (sectionDate && isDateYmd(sectionDate)) {
      setEffectiveDate(sectionDate);
      setIsDirty(false);
    }
  }, [sectionDate]);
  useEffect(() => {
    if (focusSection && !settings.isLoading && !settings.error) inputRef.current?.focus();
  }, [focusSection, settings.error, settings.isLoading]);
  useEffect(() => {
    if (isDirty || settings.isLoading || settings.error) return;
    setInputValue(settings.data?.ftp == null ? "" : String(settings.data.ftp));
  }, [isDirty, settings.data, settings.error, settings.isLoading]);
  useEffect(() => {
    setStartDate(shiftDateYmd(effectiveDate, -89));
    setEndDate(effectiveDate);
    setIsEstimating(false);
  }, [effectiveDate]);

  function changeEffectiveDate(value: Date | undefined) {
    if (!value) return;
    const nextDate = formatDateYmd(value);
    if (!isDateYmd(nextDate)) return;
    setIsDirty(false);
    setEffectiveDate(nextDate);
    setError(null);
  }
  function estimate() {
    if (!isDateYmd(startDate) || !isDateYmd(endDate) || startDate > endDate) {
      setError("Choose a valid start date on or before the end date.");
      return;
    }
    setError(null);
    setIsEstimating(true);
    void suggestions
      .refetch()
      .catch((queryError: unknown) =>
        captureException(queryError, { source: "cycling-ftp-suggestions" }),
      );
  }
  function submit(ftp: number | null) {
    setError(null);
    save.mutate({ sport: "cycling", ftp, effectiveFrom: effectiveDate });
  }
  function handleSave() {
    const ftp = wholePositiveWatts(inputValue);
    if (ftp === null) {
      setError("Enter a positive whole number for FTP (watts).");
      return;
    }
    submit(ftp);
  }

  if (settings.isLoading && !settings.data)
    return (
      <Text accessibilityRole="text" style={{ color: colors.textSecondary }}>
        Loading FTP settings…
      </Text>
    );
  if (settings.error && !settings.data)
    return (
      <Text accessibilityRole="alert" style={{ color: colors.danger }}>
        {userFacingErrorMessage(settings.error)}
      </Text>
    );
  return (
    <View nativeID="cycling-ftp" style={{ gap: 12 }}>
      {settings.error ? (
        <Text accessibilityRole="alert" style={{ color: colors.danger }}>
          {userFacingErrorMessage(settings.error)}
        </Text>
      ) : null}
      <View style={{ gap: 12 }}>
        <View>
          <Text style={styles.label}>Effective date</Text>
          <DateTimePicker
            accessibilityLabel="Effective date"
            value={localDate(effectiveDate)}
            mode="date"
            display="compact"
            disabled={save.isPending}
            onChange={(_event, value) => changeEffectiveDate(value)}
          />
        </View>
        <View>
          <Text style={styles.label}>Saved FTP dates</Text>
          {history.isLoading ? (
            <ActivityIndicator accessibilityLabel="Loading FTP history" />
          ) : (
            (history.data ?? []).map((entry: { effectiveFrom: string; ftp: number | null }) => (
              <TouchableOpacity
                key={entry.effectiveFrom}
                onPress={() => changeEffectiveDate(localDate(entry.effectiveFrom))}
                disabled={save.isPending}
                accessibilityRole="button"
                accessibilityLabel={`Use FTP date ${entry.effectiveFrom}`}
              >
                <Text style={styles.link}>
                  {formatDateLong(entry.effectiveFrom)} —{" "}
                  {entry.ftp == null ? "cleared" : `${formatNumber(entry.ftp, 0)} W`}
                </Text>
              </TouchableOpacity>
            ))
          )}
          {history.error ? (
            <Text accessibilityRole="alert" style={{ color: colors.danger }}>
              Saved FTP history could not be loaded: {userFacingErrorMessage(history.error)}
            </Text>
          ) : null}
        </View>
      </View>
      <View>
        <Text style={styles.label}>FTP (watts)</Text>
        <TextInput
          ref={inputRef}
          style={styles.input}
          accessibilityLabel="FTP watts"
          value={inputValue}
          onChangeText={(value) => {
            setInputValue(value);
            setIsDirty(true);
          }}
          keyboardType="number-pad"
          placeholder="Whole watts"
          placeholderTextColor={colors.textSecondary}
          editable={!save.isPending}
        />
        <Text style={styles.secondary}>
          {settings.data?.ftp == null
            ? "No FTP is set for this date."
            : `${formatNumber(settings.data.ftp, 0)} W applies on ${formatDateLong(effectiveDate)} (setting effective ${formatDateLong(settings.data.effectiveFrom)}).`}
        </Text>
      </View>
      <View style={styles.row}>
        <Action label="Estimate" onPress={estimate} disabled={save.isPending} />
        <Action label="Save" onPress={handleSave} disabled={save.isPending || settings.isLoading} />
        <Action
          label="Clear"
          onPress={() => submit(null)}
          disabled={save.isPending || settings.isLoading}
        />
      </View>
      {error ? (
        <Text accessibilityRole="alert" style={{ color: colors.danger }}>
          {error}
        </Text>
      ) : null}
      {isEstimating ? (
        <View accessibilityLabel="FTP suggestions" style={styles.suggestions}>
          <Text style={styles.label}>
            Suggestions for {formatDateLong(startDate)} to {formatDateLong(endDate)}
          </Text>
          <View style={styles.row}>
            <DateTimePicker
              accessibilityLabel="Start date"
              value={localDate(startDate)}
              mode="date"
              display="compact"
              maximumDate={localDate(endDate)}
              onChange={(_event, value) => value && setStartDate(formatDateYmd(value))}
            />
            <DateTimePicker
              accessibilityLabel="End date"
              value={localDate(endDate)}
              mode="date"
              display="compact"
              minimumDate={localDate(startDate)}
              onChange={(_event, value) => value && setEndDate(formatDateYmd(value))}
            />
          </View>
          <Text style={styles.secondary}>
            Inclusive 90-day window by default. Ordinary rides may not be maximal; easy-only riding
            can underestimate FTP.
          </Text>
          <Text
            accessibilityLiveRegion="polite"
            style={{ color: colors.textSecondary, minHeight: 20, lineHeight: 20 }}
          >
            {suggestions.isFetching ? "Estimating from recorded activities…" : null}
          </Text>
          {suggestions.error ? (
            <Text accessibilityRole="alert" style={{ color: colors.danger }}>
              {userFacingErrorMessage(suggestions.error)}
            </Text>
          ) : null}
          {suggestions.data?.methods.map((method) => (
            <View key={method.method} style={styles.method}>
              <Text style={styles.label}>{methodLabel(method.method)}</Text>
              {method.suggested_ftp == null ? (
                <Text style={{ color: colors.textSecondary }}>
                  {method.unavailable_reason ?? "No supported evidence."}
                </Text>
              ) : (
                <View style={styles.row}>
                  <Text style={{ color: colors.text }}>
                    Suggested {formatNumber(method.suggested_ftp, 0)} W
                  </Text>
                  <Action
                    label="Use this value"
                    disabled={save.isPending}
                    onPress={() => {
                      setInputValue(String(method.suggested_ftp));
                      setIsDirty(true);
                    }}
                  />
                </View>
              )}
              {method.evidence ? (
                <Text style={styles.secondary}>
                  Evidence: {method.evidence.activity_name ?? "Ride"} on{" "}
                  {formatDateLong(method.evidence.date)} —{" "}
                  {formatDurationSeconds(method.evidence.duration_seconds)} at{" "}
                  {formatNumber(method.evidence.power_watts, 0)} W.
                </Text>
              ) : null}
              <Text style={styles.secondary}>{method.limitations}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function Action({
  label,
  onPress,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy: disabled }}
      style={styles.action}
    >
      <Text style={styles.actionText}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = {
  label: { color: colors.text, fontWeight: "600" as const, marginBottom: 4 },
  secondary: { color: colors.textSecondary, fontSize: 13 },
  link: { color: colors.accent, paddingVertical: 6 },
  row: {
    flexDirection: "row" as const,
    flexWrap: "wrap" as const,
    gap: 8,
    alignItems: "center" as const,
  },
  action: {
    minHeight: 44,
    borderRadius: 8,
    paddingHorizontal: 12,
    justifyContent: "center" as const,
    backgroundColor: colors.surfaceSecondary,
  },
  actionText: { color: colors.text, fontWeight: "600" as const },
  input: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    color: colors.text,
    backgroundColor: colors.surface,
  },
  suggestions: { gap: 10, padding: 12, borderRadius: 8, backgroundColor: colors.surfaceSecondary },
  method: { gap: 5, padding: 10, borderRadius: 8, backgroundColor: colors.surface },
};
