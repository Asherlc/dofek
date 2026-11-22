import {
  formatClimbingHoldTypes,
  formatClimbingLocationPath,
} from "@dofek/format/climbing-context";
import {
  climbingAttemptDetailFields,
  formatClimbingGradeComponents,
  formatClimbingProjectDay,
  formatClimbingProjectHistory,
} from "@dofek/format/climbing-log";
import { formatDateMedium } from "@dofek/format/format";
import { providerLabel } from "@dofek/providers/providers";
import { climbingLogEntryAreaPath, climbingLogEntryName } from "@dofek/training/climbing-log";
import type { ClimbingProjectHistoryState } from "@dofek/training/climbing-project-history";
import { climbingTagGroups } from "@dofek/training/climbing-tag-presentation";
import { useId, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ClimbingLogEntryDetail } from "../../server/src/contracts/climbing-log-contracts.ts";
import { colors } from "../theme";
import { ClimbingCatalogueContext } from "./ClimbingCatalogueContext";
import { ClimbingLogEntryContext } from "./ClimbingLogEntryContext";
import { ClimbingLogEntrySources } from "./ClimbingLogEntrySources";
import { ClimbingPhotos } from "./ClimbingPhotos";
import { getQueryErrorMessage } from "./QueryStatePanel";

function Fields({ values }: { values: Array<{ label: string; value: string }> }) {
  if (values.length === 0) return null;
  return (
    <View style={styles.fields}>
      {values.map(({ label, value }) => (
        <View key={label} style={styles.row}>
          <Text style={styles.label}>{label}</Text>
          <Text style={styles.value}>{value}</Text>
        </View>
      ))}
    </View>
  );
}

function ProjectHistory({ data, error, isLoading }: ClimbingProjectHistoryState) {
  const [open, setOpen] = useState(false);
  const visitsId = useId();
  if (!data && !error && !isLoading) return null;
  const copy = data ? formatClimbingProjectHistory(data) : null;
  return (
    <View style={styles.history}>
      <Text accessibilityRole="header" style={styles.heading}>
        Project history
      </Text>
      {error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {getQueryErrorMessage(error)}
        </Text>
      )}
      {isLoading && !data && (
        <Text accessibilityLiveRegion="polite" style={styles.label}>
          Loading project history…
        </Text>
      )}
      {copy && (
        <>
          <Text style={styles.historyMetric}>{copy.summary}</Text>
          <Text style={styles.label}>{copy.detail}</Text>
          {copy.methodDetail && <Text style={styles.label}>{copy.methodDetail}</Text>}
        </>
      )}
      {data && (
        <>
          <Pressable
            accessibilityRole="button"
            aria-expanded={open}
            aria-controls={visitsId}
            onPress={() => setOpen(!open)}
            style={styles.historyButton}
          >
            <Text style={styles.historyLink}>View sessions</Text>
          </Pressable>
          {open && (
            <View nativeID={visitsId}>
              {data.days.map((day) => (
                <View key={day.date} style={styles.historyDay}>
                  <Text style={styles.label}>
                    {formatDateMedium(day.date, { timeZone: "UTC" })}
                  </Text>
                  <Text style={styles.value}>{formatClimbingProjectDay(day)}</Text>
                </View>
              ))}
            </View>
          )}
        </>
      )}
    </View>
  );
}

export function ClimbingLogEntryDetails({
  entry,
  projectHistory,
}: {
  entry: ClimbingLogEntryDetail;
  projectHistory?: ClimbingProjectHistoryState;
}) {
  const climb = entry.climb;
  const path = formatClimbingLocationPath(climbingLogEntryAreaPath(entry));
  const holds = formatClimbingHoldTypes(entry.holdTypes);
  const tagGroups = climbingTagGroups(entry.tags ?? [], entry.holdTypes);
  const gradedPitches = climb?.pitches.filter((pitch) => pitch.publishedGrades.length > 0) ?? [];
  return (
    <View style={styles.container}>
      <ClimbingLogEntrySources
        climbKind={climb?.kind ?? null}
        name={climbingLogEntryName(entry)}
        sourceName={entry.sourceName}
        providerId={entry.providerId}
        links={entry.sourceLinks}
      />
      <Fields
        values={[
          ...(entry.climbedOn && !entry.chartAnnotations?.length
            ? [{ label: "Date", value: entry.climbedOn }]
            : []),
          ...(entry.discipline
            ? [{ label: "Discipline", value: entry.discipline.replaceAll("_", " ") }]
            : []),
        ]}
      />
      {path && <Text style={styles.label}>{path}</Text>}
      <ClimbingLogEntryContext entry={entry} />
      {holds && <Text style={styles.value}>{holds}</Text>}
      {tagGroups.map((group) => (
        <View key={group.key} style={styles.section}>
          <Text style={styles.heading}>
            {providerLabel(group.providerId)} · {group.categoryLabel}
          </Text>
          {group.tags.map((tag) => (
            <Text key={tag.sourceKey} style={styles.value}>
              {tag.label}
            </Text>
          ))}
        </View>
      ))}
      {climb && (
        <>
          <Fields
            values={[
              ...(climb.kind ? [{ label: "Type", value: climb.kind }] : []),
              ...(climb.setting ? [{ label: "Setting", value: climb.setting }] : []),
              ...(climb.routeProtection?.length
                ? [{ label: "Protection", value: climb.routeProtection.join(", ") }]
                : []),
            ]}
          />
          {climb.publishedGrades.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.heading}>Grades</Text>
              <Text style={styles.value}>
                {formatClimbingGradeComponents(climb.publishedGrades)}
              </Text>
            </View>
          )}
          {gradedPitches.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.heading}>Pitch grades</Text>
              {gradedPitches.map((pitch) => (
                <View key={pitch.id} style={styles.section}>
                  <Text style={styles.value}>
                    {pitch.number === null ? "Pitch" : `Pitch ${pitch.number}`}
                    {pitch.name === null ? "" : ` · ${pitch.name}`}
                  </Text>
                  <Text style={styles.value}>
                    {formatClimbingGradeComponents(pitch.publishedGrades)}
                  </Text>
                </View>
              ))}
            </View>
          )}
        </>
      )}
      {entry.reportedGrades.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.heading}>Reported grades</Text>
          <Text style={styles.value}>{formatClimbingGradeComponents(entry.reportedGrades)}</Text>
        </View>
      )}
      {projectHistory && <ProjectHistory key={entry.id} {...projectHistory} />}
      {entry.attempts.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.heading}>
            {entry.recordedClimbAttemptCount === null
              ? "Recorded result"
              : entry.recordedClimbAttemptCount > 0
                ? `Attempts: ${entry.recordedClimbAttemptCount}`
                : "Attempts"}
          </Text>
          {entry.attempts.map((attempt) => {
            const pitch = climb?.pitches.find((candidate) => candidate.id === attempt.pitchId);
            const title =
              attempt.scope === "pitch"
                ? (pitch?.name ??
                  (pitch?.number == null ? "Pitch attempt" : `Pitch ${pitch.number}`))
                : entry.recordedClimbAttemptCount === null && attempt.attemptIndex === null
                  ? "Climb"
                  : attempt.attemptIndex === null
                    ? "Attempt (order unknown)"
                    : `Attempt ${attempt.attemptIndex}`;
            return (
              <View key={attempt.id} style={styles.attempt}>
                <Text style={styles.heading}>
                  {title}
                  {attempt.scope === "pitch" && attempt.attemptIndex !== null
                    ? ` · Attempt ${attempt.attemptIndex}`
                    : ""}
                </Text>
                {attempt.rockResultLabels.length > 0 && (
                  <Text style={styles.result}>{attempt.rockResultLabels.join(" · ")}</Text>
                )}
                <Fields values={climbingAttemptDetailFields(attempt)} />
                {attempt.notes && <Text style={styles.value}>{attempt.notes}</Text>}
              </View>
            );
          })}
        </View>
      )}
      <ClimbingCatalogueContext id={entry.id} />
      {entry.photoLogEntryId !== null && <ClimbingPhotos id={entry.photoLogEntryId} />}
      {entry.notes && (
        <View style={styles.section}>
          <Text style={styles.heading}>Notes</Text>
          <Text style={styles.value}>{entry.notes}</Text>
        </View>
      )}
    </View>
  );
}
const styles = StyleSheet.create({
  history: { padding: 12, gap: 6, backgroundColor: colors.surface, borderRadius: 12 },
  historyMetric: { color: colors.text, fontSize: 15, fontWeight: "600" },
  historyButton: { minHeight: 44, justifyContent: "center" },
  historyLink: { color: colors.accent, fontSize: 13, fontWeight: "600" },
  historyDay: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingVertical: 8,
  },
  error: { fontSize: 12, color: colors.negative },
  container: { gap: 16 },
  section: { gap: 8 },
  fields: { gap: 6 },
  row: { flexDirection: "row", gap: 12, flexWrap: "wrap" },
  label: { fontSize: 12, color: colors.textSecondary },
  value: { fontSize: 12, color: colors.text, flexShrink: 1 },
  heading: { fontSize: 13, fontWeight: "600", color: colors.text },
  result: { fontSize: 12, color: colors.positive },
  attempt: { padding: 12, gap: 8, borderWidth: 1, borderColor: colors.border, borderRadius: 8 },
});
