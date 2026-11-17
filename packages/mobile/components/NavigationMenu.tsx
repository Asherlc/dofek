import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing } from "../theme";

export interface NavigationEntry {
  title: string;
  subtitle?: string;
  onPress: () => void;
}

export function NavigationMenu({ groups }: { groups: ReadonlyArray<readonly NavigationEntry[]> }) {
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {groups.map((entries) => (
        <View key={entries[0]?.title} style={styles.group}>
          {entries.map(({ title, subtitle, onPress }, index) => (
            <Pressable
              key={title}
              accessibilityRole="button"
              accessibilityLabel={title}
              accessibilityHint={subtitle}
              onPress={onPress}
              style={[styles.row, index > 0 && styles.divider]}
            >
              <View style={styles.label}>
                <Text style={styles.title}>{title}</Text>
                {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
              </View>
              <Text style={styles.chevron} accessibilityElementsHidden>
                ›
              </Text>
            </Pressable>
          ))}
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, gap: spacing.md },
  group: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 48,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  label: { flex: 1, gap: spacing.xs },
  title: { color: colors.text, fontSize: 16, fontWeight: "600" },
  subtitle: { color: colors.textSecondary, fontSize: 13 },
  chevron: { color: colors.accent, fontSize: 22 },
});
