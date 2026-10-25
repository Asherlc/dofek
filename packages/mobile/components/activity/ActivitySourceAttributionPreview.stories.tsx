import { Ionicons } from "@expo/vector-icons";
import type { Meta, StoryObj } from "@storybook/react-native";
import { useState } from "react";
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { colors } from "../../theme";
import { ProviderLogo } from "../ProviderLogo";
import { AreaChart, CHART_COLORS } from "./ActivityDetailCharts";

type Treatment = "icons" | "pills";
type Source = {
  id: string;
  name: string;
  provider: string;
  route: "health" | "cloud" | "bluetooth";
  attribution: string;
};

const watch: Source = {
  id: "watch",
  name: "Asher’s Apple Watch",
  provider: "apple-watch",
  route: "health",
  attribution: "via Apple Health",
};
const garmin: Source = {
  id: "garmin",
  name: "Garmin Edge 1050",
  provider: "garmin",
  route: "cloud",
  attribution: "via Garmin Connect",
};
const whoopCloud: Source = {
  id: "whoop-cloud",
  name: "WHOOP",
  provider: "whoop",
  route: "cloud",
  attribution: "via WHOOP Cloud",
};
const whoopBluetooth: Source = {
  id: "whoop-bluetooth",
  name: "WHOOP",
  provider: "whoop",
  route: "bluetooth",
  attribution: "via Bluetooth",
};
const logoServer = Platform.OS === "web" ? "" : "https://dofek.fit";
const elevation = [
  142, 148, 165, 173, 181, 174, 190, 196, 187, 185, 170, 168, 154, 147, 150, 144, 135, 130, 139,
  157, 179, 188, 176, 164, 151, 148, 145,
].map((value, index) => ({
  recordedAt: new Date(Date.UTC(2026, 9, 25, 8, index * 2)).toISOString(),
  value,
}));

function RouteBadge({ source, treatment }: { source: Source; treatment: Treatment }) {
  const label = { health: "Health", cloud: "Cloud", bluetooth: "Bluetooth" }[source.route];
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.badge, treatment === "pills" && styles.pill]}
    >
      {source.route === "health" ? (
        <ProviderLogo provider="apple_health" serverUrl={logoServer} size={14} />
      ) : (
        <Ionicons
          name={source.route === "cloud" ? "cloud-outline" : "bluetooth-outline"}
          size={14}
          color={colors.textSecondary}
        />
      )}
      {treatment === "pills" && <Text style={styles.badgeLabel}>{label}</Text>}
    </View>
  );
}

function SourcePicker({
  treatment,
  metric,
  initialSource,
  choices,
}: {
  treatment: Treatment;
  metric: string;
  initialSource: Source;
  choices: Source[];
}) {
  const [selected, setSelected] = useState(initialSource);
  const [open, setOpen] = useState(false);
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${metric} source: ${selected.name}, ${selected.attribution}`}
        accessibilityState={{ expanded: open }}
        aria-haspopup="dialog"
        aria-expanded={open}
        onPress={() => setOpen(true)}
        style={({ pressed }) => [styles.trigger, pressed && { opacity: 0.7 }]}
      >
        <ProviderLogo provider={selected.provider} serverUrl={logoServer} size={22} />
        <Text numberOfLines={1} style={styles.sourceName}>
          {selected.name}
        </Text>
        <RouteBadge source={selected} treatment={treatment} />
        <Ionicons name="chevron-down" size={14} color={colors.textTertiary} />
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <View style={styles.overlay}>
          <View style={styles.dialog} accessibilityViewIsModal>
            <Text accessibilityRole="header" style={styles.dialogTitle}>
              {metric} source
            </Text>
            {choices.map((source) => (
              <Pressable
                key={source.id}
                accessibilityRole="radio"
                accessibilityLabel={`${source.name}, ${source.attribution}`}
                accessibilityState={{ checked: selected.id === source.id }}
                onPress={() => {
                  setSelected(source);
                  setOpen(false);
                }}
                style={[styles.choice, source.id === selected.id && styles.selectedChoice]}
              >
                <ProviderLogo provider={source.provider} serverUrl={logoServer} size={24} />
                <View style={styles.choiceContent}>
                  <Text style={styles.choiceName}>{source.name}</Text>
                  <Text style={styles.secondary}>{source.attribution}</Text>
                </View>
                {selected.id === source.id && (
                  <Ionicons name="checkmark" size={18} color={colors.accent} />
                )}
              </Pressable>
            ))}
            <Pressable
              accessibilityRole="button"
              onPress={() => setOpen(false)}
              style={styles.cancel}
            >
              <Text style={styles.cancelLabel}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function PreviewPanel({ treatment }: { treatment: Treatment }) {
  return (
    <View style={styles.panel}>
      <View style={styles.panelHeading}>
        <Text accessibilityRole="header" style={styles.heading}>
          {treatment === "icons" ? "A · Icon badges" : "B · Icons + short labels"}
        </Text>
        <Text style={styles.secondary}>
          {treatment === "icons"
            ? "Smallest footprint. Open for full attribution."
            : "Keeps the sync method readable at a glance."}
        </Text>
      </View>
      <View style={styles.card}>
        <View style={styles.cardHeading}>
          <Text style={styles.sectionLabel}>Elevation profile</Text>
          <SourcePicker
            treatment={treatment}
            metric="Elevation"
            initialSource={watch}
            choices={[watch, garmin]}
          />
        </View>
        <AreaChart data={elevation} color={CHART_COLORS.altitude} label="Elevation" unit="m" />
      </View>
      <View style={styles.examples}>
        <Text style={styles.sectionLabel}>Heart rate examples</Text>
        <SourcePicker
          treatment={treatment}
          metric="Heart rate"
          initialSource={whoopCloud}
          choices={[whoopCloud, whoopBluetooth]}
        />
        <SourcePicker
          treatment={treatment}
          metric="Heart rate"
          initialSource={whoopBluetooth}
          choices={[whoopCloud, whoopBluetooth]}
        />
      </View>
    </View>
  );
}

function AttributionPreview() {
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.intro}>
        <Text style={styles.eyebrow}>DESIGN PREVIEW</Text>
        <Text accessibilityRole="header" style={styles.title}>
          Source attribution
        </Text>
        <Text style={styles.secondary}>
          Compare both treatments. Tap a source to see full attribution and switch recordings.
        </Text>
      </View>
      <PreviewPanel treatment="icons" />
      <PreviewPanel treatment="pills" />
    </ScrollView>
  );
}

const meta = {
  title: "Activity/Source attribution",
  component: AttributionPreview,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof AttributionPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Comparison: Story = {};

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: 9, paddingVertical: 24, alignItems: "center", gap: 28 },
  intro: { width: "100%", maxWidth: 372, paddingHorizontal: 7, gap: 8 },
  eyebrow: { color: colors.accent, fontSize: 10, letterSpacing: 1.5, fontWeight: "700" },
  title: { fontSize: 26, fontWeight: "700", color: colors.text },
  heading: { fontSize: 17, fontWeight: "600", color: colors.text },
  secondary: { fontSize: 12, lineHeight: 18, color: colors.textSecondary },
  panel: { width: "100%", maxWidth: 372, gap: 12 },
  panelHeading: { paddingHorizontal: 7, gap: 5 },
  card: { backgroundColor: colors.surface, borderRadius: 16, overflow: "hidden" },
  cardHeading: { paddingHorizontal: 16, paddingTop: 16, gap: 12 },
  sectionLabel: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.7,
  },
  trigger: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 10,
    backgroundColor: colors.surface,
  },
  sourceName: { flex: 1, minWidth: 0, color: colors.text, fontSize: 13, fontWeight: "500" },
  badge: {
    minWidth: 24,
    minHeight: 24,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 12,
    gap: 4,
  },
  pill: { paddingHorizontal: 7 },
  badgeLabel: { fontSize: 10, color: colors.textSecondary, fontWeight: "500" },
  examples: { paddingHorizontal: 7, gap: 8 },
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    padding: 18,
    alignItems: "center",
  },
  dialog: {
    width: "100%",
    maxWidth: 360,
    padding: 16,
    borderRadius: 18,
    gap: 8,
    backgroundColor: colors.surface,
  },
  dialogTitle: { color: colors.text, fontSize: 17, fontWeight: "600", paddingBottom: 8 },
  choice: {
    minHeight: 64,
    padding: 10,
    borderRadius: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  selectedChoice: { backgroundColor: colors.accentSubtle },
  choiceContent: { flex: 1, gap: 3 },
  choiceName: { color: colors.text, fontSize: 13, fontWeight: "600" },
  cancel: { minHeight: 44, alignItems: "center", justifyContent: "center", marginTop: 4 },
  cancelLabel: { color: colors.textSecondary, fontSize: 13 },
});
