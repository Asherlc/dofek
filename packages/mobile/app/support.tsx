import { userFacingErrorMessage } from "@dofek/format/user-facing-error";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SupportPanel } from "../components/SupportPanel";
import { trpc } from "../lib/trpc";
import { colors } from "../theme";

export default function SupportScreen() {
  const createTicket = trpc.support.createTicket.useMutation();

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.section}>
        <Text style={styles.sectionDescription}>We&apos;ll reply by email.</Text>
        <View style={styles.card}>
          <SupportPanel
            isPending={createTicket.isPending}
            errorMessage={
              createTicket.error
                ? userFacingErrorMessage(
                    createTicket.error,
                    "Your support request could not be sent. Please try again.",
                  )
                : null
            }
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
