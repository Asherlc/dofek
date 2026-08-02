import type { MealType } from "@dofek/nutrition/meal";
import { MEAL_OPTIONS } from "@dofek/nutrition/meal";
import { useRef, useState } from "react";
import {
  AccessibilityInfo,
  Alert,
  Linking,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { z } from "zod";
import { SupplementDoseEventsPanel } from "../components/SupplementDoseEventsPanel";
import { captureException } from "../lib/telemetry";
import { trpc } from "../lib/trpc";
import { useRefresh } from "../lib/useRefresh";
import { colors } from "../theme";

const UNITS = ["mg", "g", "mcg", "IU", "ml", "oz"] as const;
const FORMS = ["capsule", "softgel", "tablet", "powder", "liquid", "gummy", "drop"] as const;

const supplementSchema = z.object({
  name: z.string(),
  amount: z.number().optional(),
  unit: z.string().optional(),
  form: z.string().optional(),
  meal: z.enum(["breakfast", "lunch", "dinner", "snack", "other"]).optional(),
  description: z.string().optional(),
});
type Supplement = z.infer<typeof supplementSchema>;

function formatDose(supp: Supplement): string {
  const parts: string[] = [];
  if (supp.amount != null && supp.unit) {
    parts.push(`${supp.amount}${supp.unit}`);
  }
  if (supp.form) {
    parts.push(supp.form);
  }
  return parts.join(" \u00B7 ");
}

function ChipPicker<T extends string>({
  options,
  value,
  onChange,
}: {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T | "";
  onChange: (v: T | "") => void;
}) {
  return (
    <View style={styles.chipRow}>
      {options.map((opt) => (
        <TouchableOpacity
          key={opt.value}
          style={[styles.chip, value === opt.value && styles.chipSelected]}
          onPress={() => onChange(value === opt.value ? "" : opt.value)}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={opt.label}
          accessibilityState={{ selected: value === opt.value }}
        >
          <Text style={[styles.chipText, value === opt.value && styles.chipTextSelected]}>
            {opt.label}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

export default function SupplementsScreen() {
  const [showForm, setShowForm] = useState(false);
  const [reorderAnnouncement, setReorderAnnouncement] = useState<string | null>(null);
  const saveInFlightRef = useRef(false);
  const reorderAnnouncementRef = useRef<string | null>(null);

  const utils = trpc.useUtils();
  const stack = trpc.supplements.list.useQuery();
  const safetyReview = trpc.nutritionAnalytics.micronutrientAdequacyV2.useQuery({ days: 30 });
  const saveMutation = trpc.supplements.save.useMutation({
    onSuccess: async () => {
      saveInFlightRef.current = false;
      const announcement = reorderAnnouncementRef.current;
      reorderAnnouncementRef.current = null;
      if (announcement) {
        setReorderAnnouncement(announcement);
        if (Platform.OS === "ios") {
          AccessibilityInfo.announceForAccessibility(announcement);
        }
      }
      await Promise.all([
        utils.supplements.list.invalidate(),
        utils.nutritionAnalytics.micronutrientAdequacyV2.invalidate({ days: 30 }),
      ]);
    },
    onError: (error) => {
      saveInFlightRef.current = false;
      reorderAnnouncementRef.current = null;
      setReorderAnnouncement(null);
      captureException(error, { operation: "supplements.save" });
      Alert.alert("Error", error.message);
    },
    meta: { errorReportedLocally: true },
  });

  const supplements = z.array(supplementSchema).parse(stack.data ?? []);
  const hasCanonicalStack = stack.data !== undefined;

  function handleSave(updated: Supplement[], announcement?: string): boolean {
    if (!hasCanonicalStack || saveMutation.isPending || saveInFlightRef.current) {
      return false;
    }
    saveInFlightRef.current = true;
    reorderAnnouncementRef.current = announcement ?? null;
    setReorderAnnouncement(null);
    saveMutation.mutate({ supplements: updated });
    return true;
  }

  function handleAdd(supp: Supplement) {
    if (handleSave([...supplements, supp])) {
      setShowForm(false);
    }
  }

  function handleDelete(index: number) {
    if (saveMutation.isPending || saveInFlightRef.current) {
      return;
    }
    Alert.alert("Remove Supplement", "Are you sure you want to remove this supplement?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () => handleSave(supplements.filter((_, i) => i !== index)),
      },
    ]);
  }

  function handleReorder(from: number, to: number) {
    if (!hasCanonicalStack) {
      return;
    }
    const updated = [...supplements];
    const [moved] = updated.splice(from, 1);
    if (!moved) {
      return;
    }
    updated.splice(to, 0, moved);
    handleSave(updated, `Moved ${moved.name} to position ${to + 1} of ${supplements.length}.`);
  }

  const { refreshing, onRefresh } = useRefresh();

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={colors.textSecondary}
        />
      }
    >
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Supplements</Text>
        <TouchableOpacity
          style={[
            styles.addButton,
            (!hasCanonicalStack || saveMutation.isPending) && styles.buttonDisabled,
          ]}
          onPress={() => setShowForm(!showForm)}
          disabled={!hasCanonicalStack || saveMutation.isPending}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={showForm ? "Cancel adding supplement" : "Add Supplement"}
          accessibilityState={{
            disabled: !hasCanonicalStack || saveMutation.isPending,
            expanded: showForm,
          }}
        >
          <Text style={styles.addButtonText}>{showForm ? "Cancel" : "+ Add Supplement"}</Text>
        </TouchableOpacity>
      </View>

      {showForm && hasCanonicalStack && (
        <AddSupplementForm onSubmit={handleAdd} loading={saveMutation.isPending} />
      )}

      {stack.isLoading && !hasCanonicalStack && <Text style={styles.loadingText}>Loading...</Text>}

      {stack.error && (
        <Text style={styles.errorText}>
          {hasCanonicalStack ? `Refresh failed: ${stack.error.message}` : stack.error.message}
        </Text>
      )}

      {supplements.length === 0 && !stack.isLoading && !stack.error && (
        <Text style={styles.emptyText}>
          No supplements configured. Add your daily plan, then record each dose as taken or skipped.
        </Text>
      )}

      {supplements.map((supp, index) => {
        const dose = formatDose(supp);
        const mealLabel = MEAL_OPTIONS.find((m) => m.value === supp.meal)?.label;
        return (
          <View key={supp.name} style={styles.card}>
            <View style={styles.cardRow}>
              <View style={styles.reorderColumn}>
                {index > 0 && (
                  <TouchableOpacity
                    onPress={() => handleReorder(index, index - 1)}
                    disabled={saveMutation.isPending}
                    activeOpacity={0.6}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    accessibilityRole="button"
                    accessibilityLabel={`Move ${supp.name} up`}
                    accessibilityHint="Moves this supplement one position earlier"
                    accessibilityState={{ disabled: saveMutation.isPending }}
                  >
                    <Text style={styles.reorderButtonText}>Move up</Text>
                  </TouchableOpacity>
                )}
                {index < supplements.length - 1 && (
                  <TouchableOpacity
                    onPress={() => handleReorder(index, index + 1)}
                    disabled={saveMutation.isPending}
                    activeOpacity={0.6}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    accessibilityRole="button"
                    accessibilityLabel={`Move ${supp.name} down`}
                    accessibilityHint="Moves this supplement one position later"
                    accessibilityState={{ disabled: saveMutation.isPending }}
                  >
                    <Text style={styles.reorderButtonText}>Move down</Text>
                  </TouchableOpacity>
                )}
              </View>
              <View style={styles.cardContent}>
                <Text style={styles.cardLabel}>{supp.name}</Text>
                {dose ? <Text style={styles.cardSub}>{dose}</Text> : null}
                {mealLabel ? <Text style={styles.cardMeal}>{mealLabel}</Text> : null}
              </View>
              <TouchableOpacity
                style={[styles.deleteButton, saveMutation.isPending && styles.buttonDisabled]}
                onPress={() => handleDelete(index)}
                disabled={saveMutation.isPending}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={`Delete ${supp.name}`}
                accessibilityState={{ disabled: saveMutation.isPending }}
              >
                <Text style={styles.deleteButtonText}>Delete</Text>
              </TouchableOpacity>
            </View>
          </View>
        );
      })}

      {reorderAnnouncement ? (
        <Text accessibilityLiveRegion="polite" style={styles.reorderStatus}>
          {reorderAnnouncement}
        </Text>
      ) : null}

      {saveMutation.isError && (
        <Text
          accessibilityLiveRegion="assertive"
          accessibilityRole="alert"
          style={styles.errorText}
        >
          Failed to save: {saveMutation.error.message}
        </Text>
      )}

      <View style={styles.safetySection}>
        <Text style={styles.sectionTitle}>Safety Context</Text>
        <Text style={styles.sectionSubtitle}>
          U.S. Food and Drug Administration (FDA) label references, bounded National Institutes of
          Health (NIH) adult upper limits, and medication-review guidance
        </Text>
        {safetyReview.isLoading && <Text style={styles.loadingText}>Loading...</Text>}
        {safetyReview.error && <Text style={styles.errorText}>{safetyReview.error.message}</Text>}
        {safetyReview.data && (
          <>
            <View
              style={[
                styles.safetyCard,
                safetyReview.data.professionalReview.status === "professional_review_recommended" &&
                  styles.safetyWarning,
              ]}
            >
              <Text style={styles.safetyTitle}>Medication and supplement review</Text>
              <Text style={styles.safetyText}>{safetyReview.data.professionalReview.message}</Text>
              <Text style={styles.safetyLimitation}>
                {safetyReview.data.professionalReview.limitation}
              </Text>
              <TouchableOpacity
                onPress={() => {
                  void Linking.openURL(safetyReview.data.professionalReview.source.url).catch(
                    (error: unknown) =>
                      captureException(error, { operation: "supplements.openFdaSource" }),
                  );
                }}
                accessibilityRole="link"
                accessibilityLabel="Open FDA source"
              >
                <Text style={styles.sourceLink}>FDA source</Text>
              </TouchableOpacity>
            </View>
            {safetyReview.data.nutrients
              .filter((nutrient) => nutrient.intake.supplementDailyAverage > 0)
              .map((nutrient) => {
                const sourceUrl =
                  nutrient.upperLimit.status === "not_in_ruleset"
                    ? null
                    : nutrient.upperLimit.source.url;
                return (
                  <View
                    key={nutrient.nutrientId}
                    style={[
                      styles.safetyCard,
                      nutrient.safetyStatus === "at_or_above_upper_limit" && styles.safetyDanger,
                      nutrient.safetyStatus === "upper_limit_not_evaluable" && styles.safetyWarning,
                    ]}
                  >
                    <Text style={styles.safetyTitle}>{nutrient.nutrient}</Text>
                    <Text style={styles.safetyMeta}>
                      {nutrient.intake.supplementDailyAverage} {nutrient.unit} average from
                      supplements over {nutrient.intake.daysTracked} recorded days
                    </Text>
                    <Text style={styles.safetyText}>{nutrient.upperLimit.message}</Text>
                    {sourceUrl != null && (
                      <TouchableOpacity
                        onPress={() => {
                          void Linking.openURL(sourceUrl).catch((error: unknown) =>
                            captureException(error, {
                              operation: "supplements.openNihSource",
                            }),
                          );
                        }}
                        accessibilityRole="link"
                        accessibilityLabel={`Open NIH ODS source for ${nutrient.nutrient}`}
                      >
                        <Text style={styles.sourceLink}>NIH ODS source</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                );
              })}
          </>
        )}
      </View>

      <View style={styles.doseSection}>
        <Text style={styles.sectionTitle}>Recent Doses</Text>
        <Text style={styles.sectionSubtitle}>
          Nutrients count only when you record a dose as taken.
        </Text>
        <SupplementDoseEventsPanel />
      </View>
    </ScrollView>
  );
}

function AddSupplementForm({
  onSubmit,
  loading,
}: {
  onSubmit: (supp: Supplement) => void;
  loading: boolean;
}) {
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [unit, setUnit] = useState<(typeof UNITS)[number]>("mg");
  const [form, setForm] = useState<(typeof FORMS)[number] | "">("");
  const [meal, setMeal] = useState<MealType | "">("");

  function handleSubmit() {
    if (!name.trim()) {
      Alert.alert("Missing field", "Supplement name is required.");
      return;
    }

    const supp: Supplement = { name: name.trim() };

    const parsedAmount = Number.parseFloat(amount);
    if (!Number.isNaN(parsedAmount) && parsedAmount > 0) {
      supp.amount = parsedAmount;
      supp.unit = unit;
    }

    if (form) supp.form = form;
    if (meal) supp.meal = meal;

    const descParts: string[] = [];
    if (supp.amount != null && supp.unit) descParts.push(`${supp.amount}${supp.unit}`);
    if (supp.form) descParts.push(supp.form);
    if (descParts.length > 0) supp.description = descParts.join(" ");

    onSubmit(supp);
  }

  return (
    <View style={styles.formCard}>
      <Text style={styles.formLabel}>Name</Text>
      <TextInput
        style={styles.input}
        value={name}
        onChangeText={setName}
        placeholder="e.g., Creatine Monohydrate"
        placeholderTextColor={colors.textTertiary}
      />

      <View style={styles.doseRow}>
        <View style={styles.doseField}>
          <Text style={styles.formLabel}>Amount</Text>
          <TextInput
            style={styles.input}
            value={amount}
            onChangeText={setAmount}
            placeholder="5000"
            placeholderTextColor={colors.textTertiary}
            keyboardType="numeric"
          />
        </View>
        <View style={styles.doseField}>
          <Text style={styles.formLabel}>Unit</Text>
          <ChipPicker
            options={UNITS.map((u) => ({ value: u, label: u }))}
            value={unit}
            onChange={(v) => {
              if (v !== "") setUnit(v);
            }}
          />
        </View>
      </View>

      <Text style={styles.formLabel}>Form</Text>
      <ChipPicker
        options={FORMS.map((f) => ({ value: f, label: f }))}
        value={form}
        onChange={(v) => setForm(v)}
      />

      <Text style={styles.formLabel}>Meal</Text>
      <ChipPicker
        options={MEAL_OPTIONS.map((m) => ({ value: m.value, label: m.label }))}
        value={meal}
        onChange={(v) => setMeal(v)}
      />

      <TouchableOpacity
        style={[styles.saveButton, loading && styles.saveButtonDisabled]}
        onPress={handleSubmit}
        activeOpacity={0.8}
        disabled={loading}
        accessibilityRole="button"
        accessibilityLabel="Add Supplement"
        accessibilityState={{ busy: loading, disabled: loading }}
      >
        <Text style={styles.saveButtonText}>{loading ? "Saving..." : "Add Supplement"}</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: 16, paddingTop: 24, paddingBottom: 40 },
  sectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  sectionTitle: { fontSize: 20, fontWeight: "700", color: colors.text },
  sectionSubtitle: {
    color: colors.textSecondary,
    fontSize: 13,
    marginBottom: 12,
    marginTop: 4,
  },
  safetySection: { marginTop: 28 },
  safetyCard: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.textTertiary,
    padding: 14,
    marginBottom: 8,
  },
  safetyWarning: { borderColor: colors.warning },
  safetyDanger: { borderColor: colors.danger },
  safetyTitle: { fontSize: 15, fontWeight: "700", color: colors.text },
  safetyText: { fontSize: 13, color: colors.text, marginTop: 6 },
  safetyMeta: { fontSize: 12, color: colors.textSecondary, marginTop: 4 },
  safetyLimitation: { fontSize: 12, color: colors.textSecondary, marginTop: 8 },
  sourceLink: { fontSize: 12, color: colors.accent, textDecorationLine: "underline", marginTop: 8 },
  doseSection: { marginTop: 28 },
  card: { backgroundColor: colors.surface, borderRadius: 12, padding: 14, marginBottom: 8 },
  cardRow: { flexDirection: "row", alignItems: "center" },
  cardContent: { flex: 1, marginRight: 8 },
  cardLabel: { fontSize: 16, fontWeight: "600", color: colors.text },
  cardSub: { fontSize: 13, color: colors.textSecondary, marginTop: 2 },
  cardMeal: {
    fontSize: 12,
    color: colors.textTertiary,
    marginTop: 2,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  addButton: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.surfaceSecondary,
  },
  addButtonText: { fontSize: 14, fontWeight: "600", color: colors.accent },
  buttonDisabled: { opacity: 0.5 },
  deleteButton: { paddingHorizontal: 12, paddingVertical: 6 },
  deleteButtonText: { fontSize: 13, color: colors.danger, fontWeight: "500" },
  saveButton: {
    backgroundColor: colors.accent,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 16,
  },
  saveButtonDisabled: { opacity: 0.5 },
  saveButtonText: { color: colors.text, fontSize: 16, fontWeight: "700" },
  reorderColumn: { marginRight: 10, alignItems: "flex-start", justifyContent: "center", gap: 2 },
  reorderButtonText: { fontSize: 12, color: colors.textSecondary },
  reorderStatus: { fontSize: 13, color: colors.textSecondary, marginBottom: 8 },
  formCard: { backgroundColor: colors.surface, borderRadius: 12, padding: 16, marginBottom: 12 },
  formLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.textSecondary,
    marginBottom: 6,
    marginTop: 12,
  },
  input: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 16,
    color: colors.text,
  },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: colors.surfaceSecondary,
  },
  chipSelected: { backgroundColor: colors.accent },
  chipText: { fontSize: 13, color: colors.textSecondary, fontWeight: "500" },
  chipTextSelected: { color: colors.text },
  doseRow: { flexDirection: "row", gap: 12 },
  doseField: { flex: 1 },
  loadingText: {
    fontSize: 14,
    color: colors.textSecondary,
    textAlign: "center",
    paddingVertical: 16,
  },
  emptyText: { fontSize: 14, color: colors.textTertiary, textAlign: "center", paddingVertical: 16 },
  errorText: { fontSize: 13, color: colors.danger, marginTop: 8 },
});
