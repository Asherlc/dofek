import { useLocalSearchParams } from "expo-router";
import { ScrollView, StyleSheet } from "react-native";
import { ZeppPairingCard } from "../components/ZeppPairingCard";
import { colors } from "../theme";

export default function ZeppPairingScreen() {
  const { code } = useLocalSearchParams<{ code?: string }>();

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <ZeppPairingCard initialCode={typeof code === "string" ? code : ""} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.background,
    flex: 1,
  },
  content: {
    padding: 16,
    paddingBottom: 40,
    paddingTop: 24,
  },
});
