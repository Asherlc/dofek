import { Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { ScreenSections } from "../components/ScreenSections";
import { colors, spacing } from "../theme";
import DailyHeartRateScreen from "./daily-heart-rate";
import RecoveryScreen from "./recovery";

const sections = [
  { id: "overview", title: "Overview" },
  { id: "heart-rate", title: "Heart Rate" },
] as const;

type BodySection = (typeof sections)[number]["id"];

export default function BodyScreen() {
  const params = useLocalSearchParams<{ section?: string }>();
  const initialSection = params.section === "heart-rate" ? "heart-rate" : "overview";
  const [section, setSection] = useState<BodySection>(initialSection);
  useEffect(() => setSection(initialSection), [initialSection]);

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: "Body" }} />
      <View style={styles.sections}>
        <ScreenSections
          label="Body sections"
          sections={sections}
          selected={section}
          onSelect={setSection}
        />
      </View>
      {section === "overview" ? <RecoveryScreen body /> : <DailyHeartRateScreen embedded />}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  sections: { paddingTop: spacing.sm, paddingHorizontal: spacing.md },
});
