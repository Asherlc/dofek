import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing } from "../theme";

export function ScreenSections<Section extends string>({
  label,
  sections,
  selected,
  onSelect,
  compact = false,
}: {
  label: string;
  sections: ReadonlyArray<{ id: Section; title: string }>;
  selected: Section;
  onSelect: (section: Section) => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (compact) {
    const selectedTitle = sections.find(({ id }) => id === selected)?.title ?? selected;
    return (
      <View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${label}: ${selectedTitle}`}
          accessibilityState={{ expanded: open }}
          aria-haspopup="dialog"
          aria-expanded={open}
          onPress={() => setOpen((expanded) => !expanded)}
          style={styles.compactTrigger}
        >
          <Text style={styles.compactTitle}>{selectedTitle}</Text>
          <Text
            style={styles.compactChevron}
            accessibilityElementsHidden
            importantForAccessibility="no"
          >
            {open ? "⌃" : "⌄"}
          </Text>
        </Pressable>
        {open ? (
          <Modal visible transparent animationType="fade" onRequestClose={() => setOpen(false)}>
            <View style={styles.overlay}>
              <View
                style={styles.dialog}
                role="dialog"
                accessibilityLabel={label}
                accessibilityViewIsModal
              >
                <Text style={styles.dialogTitle} accessibilityRole="header">
                  {label}
                </Text>
                <ScrollView>
                  {sections.map(({ id, title }) => (
                    <Pressable
                      key={id}
                      accessibilityRole="radio"
                      accessibilityLabel={title}
                      accessibilityState={{ checked: id === selected }}
                      aria-checked={id === selected}
                      onPress={() => {
                        onSelect(id);
                        setOpen(false);
                      }}
                      style={styles.compactChoice}
                    >
                      <Text
                        style={[styles.compactChoiceText, id === selected && styles.selectedTitle]}
                      >
                        {title}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Cancel"
                  onPress={() => setOpen(false)}
                  style={styles.compactChoice}
                >
                  <Text style={styles.cancelText}>Cancel</Text>
                </Pressable>
              </View>
            </View>
          </Modal>
        ) : null}
      </View>
    );
  }
  return (
    <View accessibilityRole="tablist" accessibilityLabel={label} style={styles.container}>
      {sections.map(({ id, title }) => (
        <Pressable
          key={id}
          accessibilityRole="tab"
          accessibilityState={{ selected: selected === id }}
          style={[styles.tab, selected === id && styles.selected]}
          onPress={() => onSelect(id)}
        >
          <Text style={[styles.title, selected === id && styles.selectedTitle]}>{title}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    flexWrap: "wrap",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    padding: spacing.xs,
    gap: spacing.xs,
  },
  tab: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
  },
  selected: { backgroundColor: colors.accentSubtle },
  title: { color: colors.text, fontSize: 14, fontWeight: "600" },
  selectedTitle: { color: colors.accent },
  compactTrigger: {
    alignSelf: "flex-start",
    alignItems: "center",
    flexDirection: "row",
    maxWidth: "100%",
    minHeight: 44,
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  compactTitle: { color: colors.text, fontSize: 14, fontWeight: "600", flexShrink: 1 },
  compactChevron: { color: colors.textSecondary, fontSize: 16 },
  overlay: { flex: 1, justifyContent: "center", padding: 24, backgroundColor: "rgba(0,0,0,0.5)" },
  dialog: {
    maxHeight: "80%",
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
    gap: spacing.xs,
  },
  dialogTitle: { color: colors.text, fontSize: 16, fontWeight: "600", marginBottom: spacing.xs },
  compactChoice: { minHeight: 44, justifyContent: "center", paddingHorizontal: spacing.sm },
  compactChoiceText: { color: colors.text, fontSize: 14, fontWeight: "600" },
  cancelText: { color: colors.textSecondary, fontSize: 14 },
});
