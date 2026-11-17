import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing } from "../theme";

export function ScreenSections<Section extends string>({
  label,
  sections,
  selected,
  onSelect,
}: {
  label: string;
  sections: ReadonlyArray<{ id: Section; title: string }>;
  selected: Section;
  onSelect: (section: Section) => void;
}) {
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
});
