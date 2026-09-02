import { formatDateYmd } from "@dofek/format/format";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { trpc } from "../lib/trpc";
import { colors } from "../theme";
import { Card } from "./Card";
import { QueryStatePanel } from "./QueryStatePanel";

export function SubjectiveTrackingPanel() {
  const [bodyRegionId, setBodyRegionId] = useState("");
  const [description, setDescription] = useState("");
  const utils = trpc.useUtils();
  const injuries = trpc.subjective.injuries.useQuery();
  const regions = trpc.subjective.regions.useQuery();
  const createInjury = trpc.subjective.createInjury.useMutation({
    onSuccess: async () => {
      setBodyRegionId("");
      setDescription("");
      await utils.subjective.injuries.invalidate();
    },
  });
  const saveCheckIn = trpc.subjective.saveCheckIn.useMutation();

  return (
    <Card>
      <Text style={styles.title}>Injuries and niggles</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="All clear today"
        disabled={saveCheckIn.isPending}
        onPress={() => saveCheckIn.mutate({ date: formatDateYmd(), symptoms: [] })}
        style={styles.checkInButton}
      >
        <Text style={styles.checkInText}>All clear today</Text>
      </Pressable>
      {saveCheckIn.error ? <Text style={styles.error}>{saveCheckIn.error.message}</Text> : null}
      {regions.isLoading && regions.data === undefined ? (
        <Text style={styles.emptyState}>Loading body regions…</Text>
      ) : regions.error && regions.data === undefined ? (
        <Text style={styles.error}>{regions.error.message}</Text>
      ) : regions.data?.length ? (
        <>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={styles.regionRow}>
              {regions.data.map((region) => {
                const selected = bodyRegionId === region.id;
                return (
                  <Pressable
                    accessibilityLabel={`Body region ${region.label}`}
                    accessibilityRole="button"
                    key={region.id}
                    onPress={() => setBodyRegionId(region.id)}
                    style={[styles.regionButton, selected && styles.regionButtonSelected]}
                  >
                    <Text style={styles.regionText}>{region.label}</Text>
                  </Pressable>
                );
              })}
            </View>
          </ScrollView>
          <TextInput
            accessibilityLabel="Injury note"
            onChangeText={setDescription}
            placeholder="What hurts or feels unusual?"
            placeholderTextColor={colors.textSecondary}
            style={styles.noteInput}
            value={description}
          />
          <Pressable
            accessibilityLabel="Log injury note"
            accessibilityRole="button"
            disabled={createInjury.isPending || !bodyRegionId || !description.trim()}
            onPress={() =>
              createInjury.mutate({
                bodyRegionId,
                description: description.trim(),
                kind: "niggle",
                onsetDate: formatDateYmd(),
                resolvedDate: null,
                severity: null,
              })
            }
            style={styles.checkInButton}
          >
            <Text style={styles.checkInText}>Log injury note</Text>
          </Pressable>
        </>
      ) : (
        <Text style={styles.emptyState}>No body regions are available.</Text>
      )}
      {regions.error && regions.data !== undefined ? (
        <Text style={styles.error}>{regions.error.message}</Text>
      ) : null}
      {createInjury.error ? <Text style={styles.error}>{createInjury.error.message}</Text> : null}
      {injuries.isLoading && injuries.data === undefined ? (
        <QueryStatePanel variant="loading" minHeight={72} />
      ) : injuries.error && injuries.data === undefined ? (
        <QueryStatePanel variant="error" message={injuries.error.message} minHeight={96} />
      ) : injuries.data?.length ? (
        injuries.data.map((injury) => (
          <Text key={injury.id} style={styles.injury}>
            {injury.kind}: {injury.description} (
            {injury.severity == null ? "severity not recorded" : `${injury.severity}/10`})
          </Text>
        ))
      ) : (
        <Text style={styles.emptyState}>No injury events logged.</Text>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  title: { color: colors.text, fontSize: 16, fontWeight: "700" },
  emptyState: { color: colors.textSecondary, fontSize: 12, marginTop: 4 },
  injury: { color: colors.textSecondary, fontSize: 12, marginTop: 4 },
  checkInButton: {
    alignSelf: "flex-start",
    borderColor: colors.border,
    borderRadius: 6,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  checkInText: { color: colors.text, fontSize: 13, fontWeight: "600" },
  error: { color: colors.danger, fontSize: 12, marginTop: 4 },
  noteInput: {
    borderColor: colors.border,
    borderRadius: 6,
    borderWidth: 1,
    color: colors.text,
    fontSize: 13,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  regionButton: {
    borderColor: colors.border,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  regionButtonSelected: { backgroundColor: colors.surface },
  regionRow: { flexDirection: "row", gap: 6 },
  regionText: { color: colors.text, fontSize: 12 },
});
