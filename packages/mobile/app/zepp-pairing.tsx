import { useLocalSearchParams } from "expo-router";
import { ScrollView, StyleSheet } from "react-native";
import { z } from "zod";
import { ZeppPairingCard } from "../components/ZeppPairingCard";
import { colors } from "../theme";

const zeppPairingParamsSchema = z.object({
  code: z.string().trim().min(1).optional(),
});

export default function ZeppPairingScreen() {
  const parsedParams = zeppPairingParamsSchema.safeParse(useLocalSearchParams());
  const initialCode = parsedParams.success ? (parsedParams.data.code ?? "") : "";

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <ZeppPairingCard initialCode={initialCode} />
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
