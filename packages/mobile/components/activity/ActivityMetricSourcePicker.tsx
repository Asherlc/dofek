import {
  type ActivityMetricSource,
  activityMetricSourceText,
} from "@dofek/providers/activity-metric-source";
import { providerSourceLogo } from "@dofek/providers/providers";
import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../../theme";
import { ProviderLogo } from "../ProviderLogo";

export function AttributionIcon({
  attribution,
  serverUrl,
}: {
  attribution: ActivityMetricSource["presentation"]["attribution"] | undefined;
  serverUrl: string;
}) {
  if (!attribution) return null;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.badge}
    >
      {attribution.kind === "apple_health" ? (
        <ProviderLogo provider="apple_health" serverUrl={serverUrl} size={14} />
      ) : (
        <Ionicons
          name={attribution.kind === "cloud" ? "cloud-outline" : "bluetooth-outline"}
          size={14}
          color={colors.textSecondary}
        />
      )}
    </View>
  );
}

export function ActivityMetricSourcePicker({
  label,
  showLabel = true,
  sources,
  selectedId,
  onChange,
  serverUrl,
}: {
  label: string;
  showLabel?: boolean;
  sources: ActivityMetricSource[];
  selectedId: string;
  onChange: (sourceId: string) => void;
  serverUrl: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = sources.find((source) => source.id === selectedId);
  const presentation = selected?.presentation;
  const sourceText = presentation ? activityMetricSourceText(presentation) : null;
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label} source: ${selected?.label ?? ""}`}
        accessibilityState={{ expanded: open }}
        aria-haspopup="dialog"
        onPress={() => setOpen(true)}
        style={styles.trigger}
      >
        {showLabel && <Text style={styles.metricLabel}>{label} · </Text>}
        {presentation && (
          <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <ProviderLogo
              provider={
                providerSourceLogo(presentation.providerId, presentation.sourceName).provider
              }
              sourceName={presentation.sourceName}
              serverUrl={serverUrl}
              size={22}
            />
          </View>
        )}
        {sourceText && (
          <Text numberOfLines={1} style={styles.sourceName}>
            {sourceText}
          </Text>
        )}
        <AttributionIcon attribution={presentation?.attribution} serverUrl={serverUrl} />
        <Ionicons name="chevron-down" size={14} color={colors.textTertiary} accessible={false} />
      </Pressable>
      {open && (
        <Modal visible transparent animationType="fade" onRequestClose={() => setOpen(false)}>
          <View style={styles.overlay}>
            <View style={styles.dialog} accessibilityViewIsModal>
              <Text accessibilityRole="header" style={styles.dialogTitle}>
                {label} source
              </Text>
              {sources.map((source) => {
                const sourceText = activityMetricSourceText(source.presentation);
                return (
                  <Pressable
                    key={source.id}
                    accessibilityRole="radio"
                    accessibilityLabel={source.label}
                    accessibilityState={{ checked: source.id === selectedId }}
                    onPress={() => {
                      onChange(source.id);
                      setOpen(false);
                    }}
                    style={[styles.choice, styles.sourceChoice]}
                  >
                    <View
                      accessibilityElementsHidden
                      importantForAccessibility="no-hide-descendants"
                    >
                      <ProviderLogo
                        provider={
                          providerSourceLogo(
                            source.presentation.providerId,
                            source.presentation.sourceName,
                          ).provider
                        }
                        sourceName={source.presentation.sourceName}
                        serverUrl={serverUrl}
                        size={22}
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      {sourceText && (
                        <Text
                          style={{ color: source.id === selectedId ? colors.accent : colors.text }}
                        >
                          {sourceText}
                        </Text>
                      )}
                    </View>
                    <AttributionIcon
                      attribution={source.presentation.attribution}
                      serverUrl={serverUrl}
                    />
                    <Ionicons
                      name={source.id === selectedId ? "radio-button-on" : "radio-button-off"}
                      size={20}
                      color={source.id === selectedId ? colors.accent : colors.textTertiary}
                      accessible={false}
                    />
                  </Pressable>
                );
              })}
              <Pressable
                accessibilityRole="button"
                onPress={() => setOpen(false)}
                style={styles.choice}
              >
                <Text style={{ color: colors.textSecondary }}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        </Modal>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  trigger: {
    alignSelf: "flex-start",
    alignItems: "center",
    flexDirection: "row",
    maxWidth: "100%",
    minHeight: 44,
    gap: 7,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: colors.surface,
    borderRadius: 8,
  },
  metricLabel: { color: colors.textSecondary, fontSize: 13 },
  sourceName: { color: colors.text, fontSize: 13, fontWeight: "600", flexShrink: 1 },
  badge: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 7,
    backgroundColor: colors.surfaceSecondary,
  },
  overlay: { flex: 1, justifyContent: "center", padding: 24, backgroundColor: "rgba(0,0,0,0.5)" },
  dialog: { backgroundColor: colors.surface, borderRadius: 16, padding: 16, gap: 8 },
  dialogTitle: { color: colors.text, fontWeight: "600" },
  sourceChoice: { flexDirection: "row", alignItems: "center", gap: 8 },
  choice: { minHeight: 44, padding: 12, justifyContent: "center" },
});
