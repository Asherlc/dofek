import { useState } from "react";
import {
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { z } from "zod";
import { trpc } from "../lib/trpc";
import { useRefresh } from "../lib/useRefresh";
import { colors } from "../theme";
import { MEAL_OPTIONS } from "@dofek/nutrition/meal";
import type { MealType } from "@dofek/nutrition/meal";

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

  const utils = trpc.useUtils();
  const stack = trpc.supplements.list.useQuery();
  const saveMutation = trpc.supplements.save.useMutation({
    onSuccess: () => utils.supplements.list.invalidate(),
    onError: (error) => Alert.alert("Error", error.message),
  });

  const supplements = z.array(supplementSchema).parse(stack.data ?? []);

  function handleSave(updated: Supplement[]) {
    saveMutation.mutate({ supplements: updated });
  }

  function handleAdd(supp: Supplement) {
    handleSave([...supplements, supp]);
    setShowForm(false);
  }

  function handleDelete(index: number) {
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
    const updated = [...supplements];
    const [moved] = updated.splice(from, 1);
    if (moved) updated.splice(to, 0, moved);
    handleSave(updated);
  }

  const { refreshing, onRefresh } = useRefresh();

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.textSecondary} />}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Supplements</Text>
        <TouchableOpacity
          style={styles.addButton}
          onPress={() => setShowForm(!showForm)}
          activeOpacity={0.7}
        >
          <Text style={styles.addButtonText}>{showForm ? "Cancel" : "+ Add Supplement"}</Text>
        </TouchableOpacity>
      </View>

      {showForm && <AddSupplementForm onSubmit={handleAdd} loading={saveMutation.isPending} />}

      {stack.isLoading && <Text style={styles.loadingText}>Loading...</Text>}

      {supplements.length === 0 && !stack.isLoading && (
        <Text style={styles.emptyText}>
          No supplements configured. Add your daily stack and it will be synced as nutrition data.
        </Text>
      )}

      {supplements.map((supp, index) => {
        const dose = formatDose(supp);
        const mealLabel = MEAL_OPTIONS.find((m) => m.value === supp.meal)?.label;
        return (
          <View key={`${supp.name}-${index}`} style={styles.card}>
            <View style={styles.cardRow}>
              <View style={styles.reorderColumn}>
                {index > 0 && (
                  <TouchableOpacity
                    onPress={() => handleReorder(index, index - 1)}
                    activeOpacity={0.6}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Text style={styles.reorderArrow}>{"\u25B2"}</Text>
                  </TouchableOpacity>
                )}
                {index < supplements.length - 1 && (
                  <TouchableOpacity
                    onPress={() => handleReorder(index, index + 1)}
                    activeOpacity={0.6}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Text style={styles.reorderArrow}>{"\u25BC"}</Text>
                  </TouchableOpacity>
                )}
              </View>
              <View style={styles.cardContent}>
                <Text style={styles.cardLabel}>{supp.name}</Text>
                {dose ? <Text style={styles.cardSub}>{dose}</Text> : null}
                {mealLabel ? <Text style={styles.cardMeal}>{mealLabel}</Text> : null}
              </View>
              <TouchableOpacity
                style={styles.deleteButton}
                onPress={() => handleDelete(index)}
                activeOpacity={0.7}
              >
                <Text style={styles.deleteButtonText}>Delete</Text>
              </TouchableOpacity>
            </View>
          </View>
        );
      })}

      {saveMutation.isError && (
        <Text style={styles.errorText}>Failed to save: {saveMutation.error.message}</Text>
      )}
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
              if (v) setUnit(v as (typeof UNITS)[number]);
            }}
          />
        </View>
      </View>

      <Text style={styles.formLabel}>Form</Text>
      <ChipPicker
        options={FORMS.map((f) => ({ value: f, label: f }))}
        value={form}
        onChange={(v) => setForm(v as (typeof FORMS)[number] | "")}
      />

      <Text style={styles.formLabel}>Meal</Text>
      <ChipPicker
        options={MEAL_OPTIONS.map((m) => ({ value: m.value, label: m.label }))}
        value={meal}
        onChange={(v) => setMeal(v as MealType | "")}
      />

      <TouchableOpacity
        style={[styles.saveButton, loading && styles.saveButtonDisabled]}
        onPress={handleSubmit}
        activeOpacity={0.8}
        disabled={loading}
      >
        <Text style={styles.saveButtonText}>{loading ? "Saving..." : "Add Supplement"}</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: 16, paddingTop: 24, paddingBottom: 40 },
  sectionHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  sectionTitle: { fontSize: 20, fontWeight: "700", color: colors.text },
  card: { backgroundColor: colors.surface, borderRadius: 12, padding: 14, marginBottom: 8 },
  cardRow: { flexDirection: "row", alignItems: "center" },
  cardContent: { flex: 1, marginRight: 8 },
  cardLabel: { fontSize: 16, fontWeight: "600", color: colors.text },
  cardSub: { fontSize: 13, color: colors.textSecondary, marginTop: 2 },
  cardMeal: { fontSize: 12, color: colors.textTertiary, marginTop: 2, textTransform: "uppercase", letterSpacing: 0.5 },
  addButton: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceSecondary },
  addButtonText: { fontSize: 14, fontWeight: "600", color: colors.accent },
  deleteButton: { paddingHorizontal: 12, paddingVertical: 6 },
  deleteButtonText: { fontSize: 13, color: colors.danger, fontWeight: "500" },
  saveButton: { backgroundColor: colors.accent, borderRadius: 10, paddingVertical: 14, alignItems: "center", marginTop: 16 },
  saveButtonDisabled: { opacity: 0.5 },
  saveButtonText: { color: colors.text, fontSize: 16, fontWeight: "700" },
  reorderColumn: { marginRight: 10, alignItems: "center", justifyContent: "center", gap: 2 },
  reorderArrow: { fontSize: 12, color: colors.textTertiary },
  formCard: { backgroundColor: colors.surface, borderRadius: 12, padding: 16, marginBottom: 12 },
  formLabel: { fontSize: 13, fontWeight: "600", color: colors.textSecondary, marginBottom: 6, marginTop: 12 },
  input: { backgroundColor: colors.surfaceSecondary, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 10, fontSize: 16, color: colors.text },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, backgroundColor: colors.surfaceSecondary },
  chipSelected: { backgroundColor: colors.accent },
  chipText: { fontSize: 13, color: colors.textSecondary, fontWeight: "500" },
  chipTextSelected: { color: colors.text },
  doseRow: { flexDirection: "row", gap: 12 },
  doseField: { flex: 1 },
  loadingText: { fontSize: 14, color: colors.textSecondary, textAlign: "center", paddingVertical: 16 },
  emptyText: { fontSize: 14, color: colors.textTertiary, textAlign: "center", paddingVertical: 16 },
  errorText: { fontSize: 13, color: colors.danger, marginTop: 8 },
});
