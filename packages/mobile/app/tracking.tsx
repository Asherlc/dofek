import { useMemo, useState } from "react";
import {
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { z } from "zod";
import { trpc } from "../lib/trpc";
import { useRefresh } from "../lib/useRefresh";
import { colors } from "../theme";

const lifeEventSchema = z.object({
  id: z.string(),
  label: z.string(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  category: z.string().nullable(),
  ongoing: z.boolean(),
  notes: z.string().nullable(),
});
type LifeEvent = z.infer<typeof lifeEventSchema>;

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

export default function TrackingScreen() {
  const { refreshing, onRefresh } = useRefresh();

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.textSecondary} />}>
      <Text style={styles.title}>Journal</Text>
      <JournalSection />
      <Text style={[styles.title, { marginTop: 32 }]}>Life Events</Text>
      <LifeEventsSection />
    </ScrollView>
  );
}

// ---- Journal Section ----

const journalEntrySchema = z.object({
  id: z.string(),
  date: z.string(),
  provider_id: z.string(),
  question_slug: z.string(),
  display_name: z.string(),
  category: z.string(),
  data_type: z.string(),
  unit: z.string().nullable(),
  answer_text: z.string().nullable(),
  answer_numeric: z.coerce.number().nullable(),
  impact_score: z.coerce.number().nullable(),
});
type JournalEntry = z.infer<typeof journalEntrySchema>;

const journalQuestionSchema = z.object({
  slug: z.string(),
  display_name: z.string(),
  category: z.string(),
  data_type: z.string(),
  unit: z.string().nullable(),
  sort_order: z.coerce.number(),
});

const CATEGORY_LABELS: Record<string, string> = {
  substance: "Substances",
  activity: "Activities",
  wellness: "Wellness",
  nutrition: "Nutrition",
  custom: "Custom",
};

const CATEGORY_ORDER = ["wellness", "activity", "substance", "nutrition", "custom"];

function JournalSection() {
  const [showForm, setShowForm] = useState(false);
  const [days, setDays] = useState(30);

  const utils = trpc.useUtils();
  const entriesQuery = trpc.journal.entries.useQuery({ days });
  const deleteMutation = trpc.journal.delete.useMutation({
    onSuccess: () => utils.journal.entries.invalidate(),
    onError: (error) => Alert.alert("Error", error.message),
  });

  const entries = useMemo(() => {
    if (!entriesQuery.data) return [];
    return z.array(journalEntrySchema).parse(entriesQuery.data);
  }, [entriesQuery.data]);

  // Group by date
  const grouped = useMemo(() => {
    const map = new Map<string, JournalEntry[]>();
    for (const entry of entries) {
      const existing = map.get(entry.date) ?? [];
      existing.push(entry);
      map.set(entry.date, existing);
    }
    return [...map.entries()].sort(([a], [b]) => b.localeCompare(a));
  }, [entries]);

  function handleDelete(id: string) {
    Alert.alert("Delete Entry", "Are you sure you want to delete this journal entry?", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => deleteMutation.mutate({ id }) },
    ]);
  }

  return (
    <View>
      <View style={styles.sectionHeader}>
        <View style={styles.chipRow}>
          {[7, 30, 90].map((d) => (
            <TouchableOpacity
              key={d}
              style={[styles.chip, days === d && styles.chipSelected]}
              onPress={() => setDays(d)}
              activeOpacity={0.7}
            >
              <Text style={[styles.chipText, days === d && styles.chipTextSelected]}>{d}d</Text>
            </TouchableOpacity>
          ))}
        </View>
        <TouchableOpacity
          style={styles.addButton}
          onPress={() => setShowForm(!showForm)}
          activeOpacity={0.7}
        >
          <Text style={styles.addButtonText}>{showForm ? "Cancel" : "+ Add Entry"}</Text>
        </TouchableOpacity>
      </View>

      {showForm && (
        <AddJournalEntryForm
          onSuccess={() => {
            setShowForm(false);
            utils.journal.entries.invalidate();
          }}
        />
      )}

      {entriesQuery.isLoading && <Text style={styles.loadingText}>Loading...</Text>}

      {!entriesQuery.isLoading && entries.length === 0 && (
        <Text style={styles.emptyText}>No journal entries yet.</Text>
      )}

      {grouped.map(([date, dayEntries]) => (
        <JournalDayGroup key={date} date={date} entries={dayEntries} onDelete={handleDelete} />
      ))}
    </View>
  );
}

function JournalDayGroup({
  date,
  entries,
  onDelete,
}: { date: string; entries: JournalEntry[]; onDelete: (id: string) => void }) {
  const dateDisplay = new Date(`${date}T12:00:00`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  const byCategory = useMemo(() => {
    const map = new Map<string, JournalEntry[]>();
    for (const entry of entries) {
      const existing = map.get(entry.category) ?? [];
      existing.push(entry);
      map.set(entry.category, existing);
    }
    return CATEGORY_ORDER.filter((c) => map.has(c)).map((c) => ({
      category: c,
      entries: map.get(c) ?? [],
    }));
  }, [entries]);

  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={styles.cardSub}>{dateDisplay}</Text>
      <View style={styles.card}>
        {byCategory.map(({ category, entries: catEntries }) => (
          <View key={category} style={{ marginBottom: 8 }}>
            <Text style={{ fontSize: 11, fontWeight: "600", color: colors.textTertiary, marginBottom: 4 }}>
              {CATEGORY_LABELS[category] ?? category}
            </Text>
            {catEntries.map((entry) => (
              <View key={entry.id} style={styles.cardRow}>
                <View style={styles.cardContent}>
                  <Text style={styles.cardLabel}>{entry.display_name}</Text>
                  <JournalAnswerDisplay entry={entry} />
                </View>
                {entry.impact_score !== null && (
                  <Text
                    style={{
                      fontSize: 11,
                      color: entry.impact_score >= 0 ? colors.accent : colors.danger,
                      marginRight: 8,
                    }}
                  >
                    {entry.impact_score > 0 ? "+" : ""}
                    {entry.impact_score.toFixed(1)}
                  </Text>
                )}
                {entry.provider_id === "dofek" && (
                  <TouchableOpacity
                    style={styles.deleteButton}
                    onPress={() => onDelete(entry.id)}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.deleteButtonText}>Delete</Text>
                  </TouchableOpacity>
                )}
                {entry.provider_id !== "dofek" && (
                  <Text style={{ fontSize: 11, color: colors.textTertiary }}>{entry.provider_id}</Text>
                )}
              </View>
            ))}
          </View>
        ))}
      </View>
    </View>
  );
}

function JournalAnswerDisplay({ entry }: { entry: JournalEntry }) {
  if (entry.data_type === "boolean") {
    const isYes = entry.answer_numeric !== null && entry.answer_numeric > 0;
    return (
      <Text
        style={{
          fontSize: 12,
          fontWeight: "600",
          color: isYes ? colors.accent : colors.textTertiary,
        }}
      >
        {isYes ? "Yes" : "No"}
      </Text>
    );
  }

  if (entry.data_type === "numeric" && entry.answer_numeric !== null) {
    return (
      <Text style={{ fontSize: 13, color: colors.textSecondary }}>
        {entry.answer_numeric}
        {entry.unit ? ` ${entry.unit}` : ""}
      </Text>
    );
  }

  if (entry.answer_text) {
    return (
      <Text style={{ fontSize: 13, color: colors.textSecondary, fontStyle: "italic" }}>
        {entry.answer_text}
      </Text>
    );
  }

  return null;
}

function AddJournalEntryForm({ onSuccess }: { onSuccess: () => void }) {
  const questionsQuery = trpc.journal.questions.useQuery();
  const createMutation = trpc.journal.create.useMutation({
    onSuccess,
    onError: (error) => Alert.alert("Error", error.message),
  });

  const questions = useMemo(() => {
    if (!questionsQuery.data) return [];
    return z.array(journalQuestionSchema).parse(questionsQuery.data);
  }, [questionsQuery.data]);

  const [selectedSlug, setSelectedSlug] = useState("");
  const [date, setDate] = useState(todayString());
  const [answerNumeric, setAnswerNumeric] = useState("");
  const [answerText, setAnswerText] = useState("");
  const [booleanValue, setBooleanValue] = useState(false);

  const selectedQuestion = useMemo(
    () => questions.find((q) => q.slug === selectedSlug),
    [questions, selectedSlug],
  );

  function handleSubmit() {
    if (!selectedSlug) {
      Alert.alert("Missing field", "Select a question.");
      return;
    }
    if (!date.trim()) {
      Alert.alert("Missing field", "Date is required.");
      return;
    }

    let numericValue: number | null = null;
    let textValue: string | null = null;

    if (selectedQuestion?.data_type === "boolean") {
      numericValue = booleanValue ? 1 : 0;
    } else if (selectedQuestion?.data_type === "numeric") {
      numericValue = answerNumeric ? Number(answerNumeric) : null;
    } else {
      textValue = answerText || null;
    }

    createMutation.mutate({
      date: date.trim(),
      questionSlug: selectedSlug,
      answerNumeric: numericValue,
      answerText: textValue,
    });
  }

  return (
    <View style={styles.formCard}>
      <Text style={styles.formLabel}>Date (YYYY-MM-DD)</Text>
      <TextInput
        style={styles.input}
        value={date}
        onChangeText={setDate}
        placeholder="2026-03-22"
        placeholderTextColor={colors.textTertiary}
        keyboardType="numbers-and-punctuation"
      />

      <Text style={styles.formLabel}>Question</Text>
      <View style={styles.chipRow}>
        {questions.map((q) => (
          <TouchableOpacity
            key={q.slug}
            style={[styles.chip, selectedSlug === q.slug && styles.chipSelected]}
            onPress={() => {
              setSelectedSlug(selectedSlug === q.slug ? "" : q.slug);
              setAnswerNumeric("");
              setAnswerText("");
              setBooleanValue(false);
            }}
            activeOpacity={0.7}
          >
            <Text style={[styles.chipText, selectedSlug === q.slug && styles.chipTextSelected]}>
              {q.display_name}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {selectedQuestion && (
        <>
          <Text style={styles.formLabel}>Answer</Text>

          {selectedQuestion.data_type === "boolean" && (
            <View style={styles.toggleRow}>
              <Text style={{ fontSize: 14, color: colors.text }}>
                {booleanValue ? "Yes" : "No"}
              </Text>
              <Switch
                value={booleanValue}
                onValueChange={setBooleanValue}
                trackColor={{ false: colors.surfaceSecondary, true: colors.accent }}
                thumbColor={colors.text}
              />
            </View>
          )}

          {selectedQuestion.data_type === "numeric" && (
            <TextInput
              style={styles.input}
              value={answerNumeric}
              onChangeText={setAnswerNumeric}
              placeholder={selectedQuestion.unit ? `Value (${selectedQuestion.unit})` : "Value"}
              placeholderTextColor={colors.textTertiary}
              keyboardType="decimal-pad"
            />
          )}

          {selectedQuestion.data_type === "text" && (
            <TextInput
              style={styles.input}
              value={answerText}
              onChangeText={setAnswerText}
              placeholder="Your answer..."
              placeholderTextColor={colors.textTertiary}
              multiline
            />
          )}
        </>
      )}

      <TouchableOpacity
        style={[styles.saveButton, createMutation.isPending && styles.saveButtonDisabled]}
        onPress={handleSubmit}
        activeOpacity={0.8}
        disabled={createMutation.isPending}
      >
        <Text style={styles.saveButtonText}>
          {createMutation.isPending ? "Saving..." : "Save Entry"}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

// ---- Life Events Section ----

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

  const eventList: LifeEvent[] = z.array(lifeEventSchema).parse(events.data ?? []);

  function handleDelete(id: string) {
    Alert.alert("Delete Event", "Are you sure you want to delete this event?", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => deleteMutation.mutate({ id }) },
    ]);
  }

  return (
    <View>
      <View style={styles.sectionHeader}>
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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: 16, paddingTop: 24, paddingBottom: 40 },
  title: { fontSize: 28, fontWeight: "800", color: colors.text, marginBottom: 16 },
  sectionHeader: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", marginBottom: 12 },
  card: { backgroundColor: colors.surface, borderRadius: 12, padding: 14, marginBottom: 8 },
  cardRow: { flexDirection: "row", alignItems: "center" },
  cardContent: { flex: 1, marginRight: 8 },
  cardLabel: { fontSize: 16, fontWeight: "600", color: colors.text },
  cardSub: { fontSize: 13, color: colors.textSecondary, marginTop: 2 },
  cardNotes: { fontSize: 12, color: colors.textTertiary, marginTop: 4, fontStyle: "italic" },
  eventEmoji: { fontSize: 24, marginRight: 12 },
  addButton: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceSecondary },
  addButtonText: { fontSize: 14, fontWeight: "600", color: colors.accent },
  deleteButton: { paddingHorizontal: 12, paddingVertical: 6 },
  deleteButtonText: { fontSize: 13, color: colors.danger, fontWeight: "500" },
  saveButton: { backgroundColor: colors.accent, borderRadius: 10, paddingVertical: 14, alignItems: "center", marginTop: 16 },
  saveButtonDisabled: { opacity: 0.5 },
  saveButtonText: { color: colors.text, fontSize: 16, fontWeight: "700" },
  formCard: { backgroundColor: colors.surface, borderRadius: 12, padding: 16, marginBottom: 12 },
  formLabel: { fontSize: 13, fontWeight: "600", color: colors.textSecondary, marginBottom: 6, marginTop: 12 },
  input: { backgroundColor: colors.surfaceSecondary, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 10, fontSize: 16, color: colors.text },
  toggleRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 12 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, backgroundColor: colors.surfaceSecondary },
  chipSelected: { backgroundColor: colors.accent },
  chipText: { fontSize: 13, color: colors.textSecondary, fontWeight: "500" },
  chipTextSelected: { color: colors.text },
  loadingText: { fontSize: 14, color: colors.textSecondary, textAlign: "center", paddingVertical: 16 },
  emptyText: { fontSize: 14, color: colors.textTertiary, textAlign: "center", paddingVertical: 16 },
});
