import {
  formatClimbingLocationPath,
  formatClimbingWallAngle,
} from "@dofek/format/climbing-context";
import {
  climbingAttemptDetailFields,
  formatClimbingGradeComponents,
  formatGpsCoordinates,
} from "@dofek/format/climbing-log";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ClimbingLogEntryDetail } from "../../server/src/contracts/climbing-log-contracts.ts";
import { colors } from "../theme";

function Fields({ values }: { values: Array<{ label: string; value: string }> }) {
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
function Disclosure({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.section}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
      >
        <Text style={styles.heading}>
          {open ? "▾" : "▸"} {title}
        </Text>
      </Pressable>
      {open && children}
    </View>
  );
}

export function ClimbingLogEntryDetails({ entry }: { entry: ClimbingLogEntryDetail }) {
  const climb = entry.climb;
  const path = formatClimbingLocationPath(climb?.areaPath ?? []);
  const angle = formatClimbingWallAngle(entry.wallAngle);
  return (
    <View style={styles.container}>
      <Fields
        values={[
          { label: "Date", value: entry.climbedOn ?? "Date unknown" },
          { label: "Discipline", value: entry.discipline?.replaceAll("_", " ") ?? "Unknown" },
          ...(entry.title === null ? [] : [{ label: "Log title", value: entry.title }]),
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
              { label: "Climb kind", value: climb.kind ?? "Unknown" },
              { label: "Setting", value: climb.setting ?? "Unknown" },
              { label: "Route protection", value: climb.routeProtection?.join(", ") ?? "Unknown" },
              ...(climb.coordinates === null
                ? []
                : [{ label: "Climb coordinates", value: formatGpsCoordinates(climb.coordinates) }]),
              ...climb.areaPath.flatMap((area) =>
                area.coordinates === null
                  ? []
                  : [
                      {
                        label: `${area.name} coordinates`,
                        value: formatGpsCoordinates(area.coordinates),
                      },
                    ],
              ),
            ]}
          />
          <View style={styles.section}>
            <Text style={styles.heading}>Published climb grades</Text>
            <Text style={styles.value}>
              {formatClimbingGradeComponents(climb.publishedGrades) || "None recorded"}
            </Text>
          </View>
          {climb.pitches.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.heading}>Published pitch grades</Text>
              {climb.pitches.map((pitch) => (
                <View key={pitch.id} style={styles.section}>
                  <Text style={styles.value}>
                    {pitch.number === null ? "Pitch number unknown" : `Pitch ${pitch.number}`}
                    {pitch.name === null ? "" : ` · ${pitch.name}`}
                  </Text>
                  <Text style={styles.value}>
                    {formatClimbingGradeComponents(pitch.publishedGrades) || "None recorded"}
                  </Text>
                </View>
              ))}
            </View>
          )}
        </>
      )}
      <View style={styles.section}>
        <Text style={styles.heading}>Reported grades</Text>
        <Text style={styles.value}>
          {formatClimbingGradeComponents(entry.reportedGrades) || "None recorded"}
        </Text>
      </View>
      <View style={styles.section}>
        <Text style={styles.heading}>Recorded attempts</Text>
        {entry.attempts.map((attempt) => (
          <View key={attempt.id} style={styles.attempt}>
            <Text style={styles.heading}>
              {attempt.scope === "pitch" ? "Pitch attempt" : "Whole-climb attempt"}
              {attempt.attemptIndex === null ? "" : ` · Order ${attempt.attemptIndex}`}
            </Text>
            {attempt.rockResultLabels.length > 0 && (
              <Text style={styles.result}>{attempt.rockResultLabels.join(" · ")}</Text>
            )}
            <Fields values={climbingAttemptDetailFields(attempt)} />
            {attempt.notes && <Text style={styles.value}>{attempt.notes}</Text>}
          </View>
        ))}
      </View>
      {entry.notes && (
        <View style={styles.section}>
          <Text style={styles.heading}>Notes</Text>
          <Text style={styles.value}>{entry.notes}</Text>
        </View>
      )}
      <Disclosure title="Source record">
        <Fields
          values={[
            { label: "Log identifier", value: entry.id },
            { label: "Provider", value: entry.providerId },
            { label: "Source identifier", value: entry.externalId ?? "Unknown" },
            { label: "Activity reference", value: entry.activityId ?? "Unattached" },
            { label: "Climb reference", value: entry.climbId ?? "Unidentified" },
            { label: "Provider absence", value: entry.providerAbsentAt ?? "Not reported absent" },
          ]}
        />
      </Disclosure>
      {entry.raw !== null && (
        <Disclosure title="Raw provider data">
          <Text style={styles.raw}>{JSON.stringify(entry.raw, null, 2)}</Text>
        </Disclosure>
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
  raw: { fontSize: 11, color: colors.textSecondary, fontFamily: "Menlo" },
});
