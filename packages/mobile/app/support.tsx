import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SupportPanel } from "../components/SupportPanel";
import { trpc } from "../lib/trpc";
import { colors } from "../theme";

export default function SupportScreen() {
  const createTicket = trpc.support.createTicket.useMutation();

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Contact Support</Text>
        <Text style={styles.sectionDescription}>Send us a message and we'll reply by email.</Text>
        <View style={styles.card}>
          <SupportPanel
            isPending={createTicket.isPending}
            errorMessage={createTicket.error?.message ?? null}
            ticketId={createTicket.data?.ticketId ?? null}
            onReset={() => createTicket.reset()}
            onSubmit={(draft) => createTicket.mutate(draft)}
          />
        </View>
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
    padding: 16,
    paddingTop: 24,
    paddingBottom: 40,
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  sectionDescription: {
    fontSize: 13,
    color: colors.textTertiary,
    marginBottom: 10,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
  },
});
