import { useState } from "react";
import {
  Alert,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { trpc } from "../lib/trpc";
import { colors } from "../theme";
import { MEAL_OPTIONS } from "@dofek/shared/meal";
import type { MealType } from "@dofek/shared/meal";

// ── Life Events ──

type EventCategory = "diet" | "supplement" | "injury" | "lifestyle" | "training" | "other";

const CATEGORIES: { value: EventCategory; label: string; emoji: string }[] = [
  { value: "diet", emoji: "\u{1F34E}", label: "Diet" },
  { value: "supplement", emoji: "\u{1F48A}", label: "Supplement" },
  { value: "injury", emoji: "\u{1F915}", label: "Injury" },
  { value: "lifestyle", emoji: "\u{1F3E0}", label: "Lifestyle" },
  { value: "training", emoji: "\u{1F3CB}\u{FE0F}", label: "Training" },
  { value: "other", emoji: "\u{1F4DD}", label: "Other" },
];

function categoryEmoji(category: string | null): string {
  return CATEGORIES.find((c) => c.value === category)?.emoji ?? "\u{1F4DD}";
}

function formatDateDisplay(dateString: string): string {
  const d = new Date(`${dateString}T00:00:00`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function todayString(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// ── Supplements ──

const UNITS = ["mg", "g", "mcg", "IU", "ml", "oz"] as const;
const FORMS = ["capsule", "softgel", "tablet", "powder", "liquid", "gummy", "drop"] as const;

interface Supplement {
  name: string;
  amount?: number;
  unit?: string;
  form?: string;
  meal?: MealType;
  description?: string;
}

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

// ── Picker component (reusable) ──

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

// ── Main screen ──

export default function TrackingScreen() {
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Tracking</Text>
      <LifeEventsSection />
      <View style={styles.sectionSpacer} />
      <SupplementsSection />
    </ScrollView>
  );
}

// ── Life Events Section ──

function LifeEventsSection() {
  const [showForm, setShowForm] = useState(false);

  const utils = trpc.useUtils();
  const events = trpc.lifeEvents.list.useQuery();
  const createMutation = trpc.lifeEvents.create.useMutation({
    onSuccess: () => {
      utils.lifeEvents.list.invalidate();
      setShowForm(false);
    },
    onError: (error) => Alert.alert("Error", error.message),
  });
  const deleteMutation = trpc.lifeEvents.delete.useMutation({
    onSuccess: () => utils.lifeEvents.list.invalidate(),
    onError: (error) => Alert.alert("Error", error.message),
  });

  const eventList = (events.data ?? []) as Array<{
    id: string;
    label: string;
    started_at: string;
    ended_at: string | null;
    category: string | null;
    ongoing: boolean;
    notes: string | null;
  }>;

  function handleDelete(id: string) {
    Alert.alert("Delete Event", "Are you sure you want to delete this event?", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => deleteMutation.mutate({ id }) },
    ]);
  }

  return (
    <View>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Life Events</Text>
        <TouchableOpacity
          style={styles.addButton}
          onPress={() => setShowForm(!showForm)}
          activeOpacity={0.7}
        >
          <Text style={styles.addButtonText}>{showForm ? "Cancel" : "+ Add Event"}</Text>
        </TouchableOpacity>
      </View>

      {showForm && (
        <AddEventForm
          onSubmit={(data) => createMutation.mutate(data)}
          loading={createMutation.isPending}
        />
      )}

      {events.isLoading && <Text style={styles.loadingText}>Loading...</Text>}

      {eventList.length === 0 && !events.isLoading && (
        <Text style={styles.emptyText}>No life events recorded yet.</Text>
      )}

      {eventList.map((event) => (
        <View key={event.id} style={styles.card}>
          <View style={styles.cardRow}>
            <Text style={styles.eventEmoji}>{categoryEmoji(event.category)}</Text>
            <View style={styles.cardContent}>
              <Text style={styles.cardLabel}>{event.label}</Text>
              <Text style={styles.cardSub}>
                {formatDateDisplay(event.started_at)}
                {event.ended_at
                  ? ` \u2014 ${formatDateDisplay(event.ended_at)}`
                  : event.ongoing
                    ? " \u2014 ongoing"
                    : ""}
              </Text>
              {event.notes ? <Text style={styles.cardNotes}>{event.notes}</Text> : null}
            </View>
            <TouchableOpacity
              style={styles.deleteButton}
              onPress={() => handleDelete(event.id)}
              activeOpacity={0.7}
            >
              <Text style={styles.deleteButtonText}>Delete</Text>
            </TouchableOpacity>
          </View>
        </View>
      ))}
    </View>
  );
}

// ── Add Event Form ──

function AddEventForm({
  onSubmit,
  loading,
}: {
  onSubmit: (data: {
    label: string;
    startedAt: string;
    endedAt: string | null;
    category: string | null;
    ongoing: boolean;
    notes: string | null;
  }) => void;
  loading: boolean;
}) {
  const [label, setLabel] = useState("");
  const [category, setCategory] = useState<EventCategory | "">("");
  const [startedAt, setStartedAt] = useState(todayString());
  const [ongoing, setOngoing] = useState(false);
  const [endedAt, setEndedAt] = useState("");
  const [notes, setNotes] = useState("");

  function handleSubmit() {
    if (!label.trim()) {
      Alert.alert("Missing field", "Label is required.");
      return;
    }
    if (!startedAt.trim()) {
      Alert.alert("Missing field", "Start date is required.");
      return;
    }
    onSubmit({
      label: label.trim(),
      startedAt: startedAt.trim(),
      endedAt: !ongoing && endedAt.trim() ? endedAt.trim() : null,
      category: category || null,
      ongoing,
      notes: notes.trim() || null,
    });
  }

  return (
    <View style={styles.formCard}>
      <Text style={styles.formLabel}>Label</Text>
      <TextInput
        style={styles.input}
        value={label}
        onChangeText={setLabel}
        placeholder="e.g., Started creatine, Got injured"
        placeholderTextColor={colors.textTertiary}
      />

      <Text style={styles.formLabel}>Category</Text>
      <ChipPicker
        options={CATEGORIES.map((c) => ({ value: c.value, label: `${c.emoji} ${c.label}` }))}
        value={category}
        onChange={(v) => setCategory(v as EventCategory | "")}
      />

      <Text style={styles.formLabel}>Start Date (YYYY-MM-DD)</Text>
      <TextInput
        style={styles.input}
        value={startedAt}
        onChangeText={setStartedAt}
        placeholder="2025-01-01"
        placeholderTextColor={colors.textTertiary}
        keyboardType="numbers-and-punctuation"
      />

      <View style={styles.toggleRow}>
        <Text style={styles.formLabel}>Ongoing</Text>
        <Switch
          value={ongoing}
          onValueChange={setOngoing}
          trackColor={{ false: colors.surfaceSecondary, true: colors.accent }}
          thumbColor={colors.text}
        />
      </View>

      {!ongoing && (
        <>
          <Text style={styles.formLabel}>End Date (YYYY-MM-DD)</Text>
          <TextInput
            style={styles.input}
            value={endedAt}
            onChangeText={setEndedAt}
            placeholder="Leave empty for one-time event"
            placeholderTextColor={colors.textTertiary}
            keyboardType="numbers-and-punctuation"
          />
        </>
      )}

      <Text style={styles.formLabel}>Notes</Text>
      <TextInput
        style={styles.input}
        value={notes}
        onChangeText={setNotes}
        placeholder="Optional notes"
        placeholderTextColor={colors.textTertiary}
        multiline
      />

      <TouchableOpacity
        style={[styles.saveButton, loading && styles.saveButtonDisabled]}
        onPress={handleSubmit}
        activeOpacity={0.8}
        disabled={loading}
      >
        <Text style={styles.saveButtonText}>{loading ? "Saving..." : "Save Event"}</Text>
      </TouchableOpacity>
    </View>
  );
}

// ── Supplements Section ──

function SupplementsSection() {
  const [showForm, setShowForm] = useState(false);

  const utils = trpc.useUtils();
  const stack = trpc.supplements.list.useQuery();
  const saveMutation = trpc.supplements.save.useMutation({
    onSuccess: () => utils.supplements.list.invalidate(),
    onError: (error) => Alert.alert("Error", error.message),
  });

  const supplements: Supplement[] = (stack.data ?? []) as Supplement[];

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

  return (
    <View>
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
              {/* Reorder arrows */}
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
    </View>
  );
}

// ── Add Supplement Form ──

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

    // Build description from dose info
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

// ── Styles ──

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    padding: 16,
    paddingTop: 24,
    paddingBottom: 40,
  },
  title: {
    fontSize: 28,
    fontWeight: "800",
    color: colors.text,
    marginBottom: 16,
  },

  // ── Sections ──
  sectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: "700",
    color: colors.text,
  },
  sectionSpacer: {
    height: 28,
  },

  // ── Cards ──
  card: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
  },
  cardRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  cardContent: {
    flex: 1,
    marginRight: 8,
  },
  cardLabel: {
    fontSize: 16,
    fontWeight: "600",
    color: colors.text,
  },
  cardSub: {
    fontSize: 13,
    color: colors.textSecondary,
    marginTop: 2,
  },
  cardNotes: {
    fontSize: 12,
    color: colors.textTertiary,
    marginTop: 4,
    fontStyle: "italic",
  },
  cardMeal: {
    fontSize: 12,
    color: colors.textTertiary,
    marginTop: 2,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  eventEmoji: {
    fontSize: 24,
    marginRight: 12,
  },

  // ── Buttons ──
  addButton: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.surfaceSecondary,
  },
  addButtonText: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.accent,
  },
  deleteButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  deleteButtonText: {
    fontSize: 13,
    color: colors.danger,
    fontWeight: "500",
  },
  saveButton: {
    backgroundColor: colors.accent,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 16,
  },
  saveButtonDisabled: {
    opacity: 0.5,
  },
  saveButtonText: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "700",
  },

  // ── Reorder ──
  reorderColumn: {
    marginRight: 10,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
  },
  reorderArrow: {
    fontSize: 12,
    color: colors.textTertiary,
  },

  // ── Forms ──
  formCard: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
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
  toggleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 12,
  },

  // ── Chips ──
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: colors.surfaceSecondary,
  },
  chipSelected: {
    backgroundColor: colors.accent,
  },
  chipText: {
    fontSize: 13,
    color: colors.textSecondary,
    fontWeight: "500",
  },
  chipTextSelected: {
    color: colors.text,
  },

  // ── Dose row ──
  doseRow: {
    flexDirection: "row",
    gap: 12,
  },
  doseField: {
    flex: 1,
  },

  // ── Status text ──
  loadingText: {
    fontSize: 14,
    color: colors.textSecondary,
    textAlign: "center",
    paddingVertical: 16,
  },
  emptyText: {
    fontSize: 14,
    color: colors.textTertiary,
    textAlign: "center",
    paddingVertical: 16,
  },
  errorText: {
    fontSize: 13,
    color: colors.danger,
    marginTop: 8,
  },
});
