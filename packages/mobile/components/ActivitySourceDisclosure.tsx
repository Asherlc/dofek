import type { ActivityOrigin } from "@dofek/providers/activity-origin";
import { activitySourceDetails } from "@dofek/providers/activity-source-details";
import { type ComponentRef, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SERVER_URL } from "../lib/server";
import { colors, radius, spacing } from "../theme";
import { ProviderLogo } from "./ProviderLogo";

export function ActivitySourceDisclosure({ origin }: { origin: ActivityOrigin }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<ComponentRef<typeof View>>(null);
  const details = activitySourceDetails(origin);
  if (!details) return null;

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };
  const restoreFocus = () => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    trigger.focus();
    if (Platform.OS !== "web") AccessibilityInfo.sendAccessibilityEvent(trigger, "focus");
  };

  return (
    <>
      <Pressable
        ref={triggerRef}
        style={styles.trigger}
        accessibilityRole="button"
        accessible
        accessibilityLabel={`Activity source: ${details.recordingApp.label}`}
        accessibilityHint="Show recording and import details"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(true)}
      >
        <ProviderLogo
          provider={details.recordingApp.provider}
          sourceName={
            origin.status === "resolved" && origin.providerId === "garmin"
              ? origin.sourceName
              : undefined
          }
          serverUrl={SERVER_URL}
          size={18}
        />
        <Text style={styles.chevron} accessibilityElementsHidden importantForAccessibility="no">
          ⌄
        </Text>
      </Pressable>
      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={close}
        onDismiss={restoreFocus}
      >
        {open ? (
          <View style={styles.backdrop}>
            <Pressable
              style={styles.dismissArea}
              accessibilityRole="button"
              accessibilityLabel="Dismiss activity source details"
              onPress={close}
            />
            <View
              style={styles.dialog}
              accessibilityViewIsModal
              role="dialog"
              accessibilityLabel="Activity source details"
              onAccessibilityEscape={close}
            >
              <Text style={styles.title} accessibilityRole="header">
                Activity source
              </Text>
              <View style={styles.sourceRow}>
                <Text style={styles.role}>Recorded in</Text>
                <Text style={styles.app}>{details.recordingApp.label}</Text>
              </View>
              {details.importedVia ? (
                <View style={styles.sourceRow}>
                  <Text style={styles.role}>Imported via</Text>
                  <Text style={styles.app}>{details.importedVia.label}</Text>
                </View>
              ) : null}
              <Pressable
                style={styles.closeButton}
                accessibilityRole="button"
                accessibilityLabel="Close activity source details"
                onPress={close}
              >
                <Text style={styles.closeLabel}>Close</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  trigger: {
    minWidth: 44,
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    borderRadius: radius.sm,
  },
  chevron: { color: colors.textSecondary, fontSize: 16 },
  backdrop: {
    flex: 1,
    justifyContent: "center",
    padding: spacing.lg,
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  dismissArea: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 },
  dialog: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.md,
    width: "100%",
    maxWidth: 400,
    alignSelf: "center",
  },
  title: { color: colors.text, fontSize: 18, fontWeight: "600" },
  sourceRow: { gap: spacing.xs },
  role: { color: colors.textSecondary, fontSize: 12 },
  app: { color: colors.text, fontSize: 15, fontWeight: "600" },
  closeButton: { minHeight: 44, alignItems: "center", justifyContent: "center" },
  closeLabel: { color: colors.accent, fontSize: 15, fontWeight: "600" },
});
