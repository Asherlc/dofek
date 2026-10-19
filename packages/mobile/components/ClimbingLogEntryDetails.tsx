import {
  formatClimbingLocationPath,
  formatClimbingWallAngle,
} from "@dofek/format/climbing-context";
import {
  climbingAttemptDetailFields,
  formatClimbingGradeComponents,
} from "@dofek/format/climbing-log";
import { StyleSheet, Text, View } from "react-native";
import type { ClimbingLogEntryDetail } from "../../server/src/contracts/climbing-log-contracts.ts";
import { colors } from "../theme";
import { ClimbingLogEntrySources } from "./ClimbingLogEntrySources";

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

export function ClimbingLogEntryDetails({ entry }: { entry: ClimbingLogEntryDetail }) {
  const climb = entry.climb;
  const path = formatClimbingLocationPath(climb?.areaPath ?? []);
  const angle = formatClimbingWallAngle(entry.wallAngle);
  const gradedPitches = climb?.pitches.filter((pitch) => pitch.publishedGrades.length > 0) ?? [];
  return (
    <View style={styles.container}>
      <ClimbingLogEntrySources
        name={climb?.name ?? entry.title ?? "Climbing log"}
        sourceName={entry.sourceName}
        links={entry.sourceLinks}
      />
      <Fields
        values={[
          ...(entry.climbedOn ? [{ label: "Date", value: entry.climbedOn }] : []),
          ...(entry.discipline
            ? [{ label: "Discipline", value: entry.discipline.replaceAll("_", " ") }]
            : []),
        ]}
      />
      {path && <Text style={styles.label}>{path}</Text>}
      {entry.board && <Text style={styles.value}>Board: {entry.board.name}</Text>}
      {angle && <Text style={styles.value}>{angle}</Text>}
      {entry.holdType && <Text style={styles.value}>Hold type: {entry.holdType}</Text>}
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
      {entry.attempts.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.heading}>
            {entry.recordedClimbAttemptCount === null ? "Recorded result" : "Attempts"}
          </Text>
          {entry.attempts.map((attempt, index) => {
            const pitch = climb?.pitches.find((candidate) => candidate.id === attempt.pitchId);
            const title =
              attempt.scope === "pitch"
                ? (pitch?.name ??
                  (pitch?.number == null ? "Pitch attempt" : `Pitch ${pitch.number}`))
                : entry.recordedClimbAttemptCount === null
                  ? "Climb"
                  : `Attempt ${attempt.attemptIndex ?? index + 1}`;
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
