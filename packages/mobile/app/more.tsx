import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing } from "../theme";

const destinations = [
  {
    href: "/settings",
    icon: "person-circle-outline",
    title: "Account & settings",
    description: "Manage your profile, preferences, data sources, and account.",
  },
  {
    href: "/breathwork",
    icon: "leaf-outline",
    title: "Breathwork",
    description: "Start a guided breathing session and review recent practice.",
  },
  {
    href: "/cycle",
    icon: "calendar-outline",
    title: "Cycle tracking",
    description: "Review cycle phases and record period dates.",
  },
  {
    href: "/data-quality",
    icon: "shield-checkmark-outline",
    title: "Data quality",
    description:
      "Review coverage gaps, source overlap, sync freshness, unusual observations, and manual entries.",
  },
] as const;

export default function MoreScreen() {
  const router = useRouter();

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.intro}>
        <Text style={styles.title}>More</Text>
        <Text style={styles.subtitle}>Account, wellbeing, and tracking tools</Text>
      </View>

      <View accessibilityRole="list" style={styles.destinations}>
        {destinations.map((destination) => (
          <Pressable
            key={destination.href}
            accessibilityRole="link"
            accessibilityLabel={`${destination.title}. ${destination.description}`}
            onPress={() => router.push(destination.href)}
            style={({ pressed }) => [styles.destination, pressed && styles.destinationPressed]}
          >
            <View style={styles.destinationIcon}>
              <Ionicons
                name={destination.icon}
                size={24}
                color={colors.accent}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
              />
            </View>
            <View style={styles.destinationText}>
              <Text style={styles.destinationTitle}>{destination.title}</Text>
              <Text style={styles.destinationDescription}>{destination.description}</Text>
            </View>
            <Ionicons
              name="chevron-forward"
              size={20}
              color={colors.textSecondary}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            />
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    padding: spacing.md,
    paddingBottom: spacing.xl,
    gap: spacing.lg,
  },
  intro: {
    gap: spacing.xs,
  },
  title: {
    color: colors.text,
    fontSize: 24,
    fontWeight: "700",
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  destinations: {
    gap: spacing.sm,
  },
  destination: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.lg,
    borderWidth: 1,
    flexDirection: "row",
    gap: spacing.md,
    minHeight: 88,
    padding: spacing.md,
  },
  destinationPressed: {
    opacity: 0.72,
  },
  destinationIcon: {
    alignItems: "center",
    justifyContent: "center",
    width: 28,
  },
  destinationText: {
    flex: 1,
    gap: spacing.xs,
  },
  destinationTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "700",
  },
  destinationDescription: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
});
