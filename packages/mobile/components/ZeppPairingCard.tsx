import { useEffect, useState } from "react";
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { trpc } from "../lib/trpc";
import { colors } from "../theme";

interface ZeppPairingCardBodyProps {
  connections: Array<{ connectionType: "zepp-main" | "zepp-workout" }>;
  connectionsError: string | null;
  disconnectError: string | null;
  isConnectionsLoading: boolean;
  pairingCode: string;
  pairingMessage: string;
  isError: boolean;
  isPending: boolean;
  onPairingCodeChange: (value: string) => void;
  onClaimPairing: () => void;
  onDisconnect: (connectionType: "zepp-main" | "zepp-workout") => void;
}

export function ZeppPairingCard({ initialCode = "" }: { initialCode?: string }) {
  const [pairingCode, setPairingCode] = useState(initialCode);
  const [pairingMessage, setPairingMessage] = useState("");
  useEffect(() => {
    setPairingCode(initialCode);
  }, [initialCode]);
  const connectionsQuery = trpc.companionToken.list.useQuery();
  const disconnectMutation = trpc.companionToken.revoke.useMutation({
    onSuccess: async () => {
      await connectionsQuery.refetch();
    },
  });
  const pairingMutation = trpc.companionPairing.claim.useMutation({
    onMutate: () => {
      setPairingMessage("");
    },
    onSuccess: async ({ connectionType }) => {
      setPairingCode("");
      setPairingMessage(
        `${
          connectionType === "zepp-main" ? "Zepp app" : "Workout extension"
        } connected. Return to Zepp to sync.`,
      );
      await connectionsQuery.refetch();
    },
    onError: (error) => {
      setPairingMessage(error.message);
    },
  });

  function handleClaimPairing() {
    setPairingMessage("");
    pairingMutation.mutate({ code: pairingCode });
  }

  return (
    <ZeppPairingCardBody
      connections={connectionsQuery.data ?? []}
      connectionsError={connectionsQuery.error?.message ?? null}
      disconnectError={disconnectMutation.error?.message ?? null}
      isConnectionsLoading={connectionsQuery.isLoading}
      pairingCode={pairingCode}
      pairingMessage={pairingMessage}
      isError={pairingMutation.isError}
      isPending={pairingMutation.isPending}
      onPairingCodeChange={(value) => {
        setPairingCode(value);
        setPairingMessage("");
      }}
      onClaimPairing={handleClaimPairing}
      onDisconnect={(connectionType) => {
        disconnectMutation.mutate({ connectionType });
      }}
    />
  );
}

export function ZeppPairingCardBody({
  connections,
  connectionsError,
  disconnectError,
  isConnectionsLoading,
  pairingCode,
  pairingMessage,
  isError,
  isPending,
  onPairingCodeChange,
  onClaimPairing,
  onDisconnect,
}: ZeppPairingCardBodyProps) {
  const normalizedPairingCode = pairingCode.trim();

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Zepp App Pairing</Text>
      <Text style={styles.sectionDescription}>Connect the Zepp watch app to this account</Text>
      <View style={styles.card}>
        <Text style={styles.statusTitle}>Current connections</Text>
        {isConnectionsLoading ? (
          <Text style={styles.notConnectedText}>Checking connections…</Text>
        ) : connectionsError ? (
          <Text style={styles.errorText}>{connectionsError}</Text>
        ) : connections.length > 0 ? (
          connections.map(({ connectionType }) => (
            <View key={connectionType} style={styles.connectionRow}>
              <Text style={styles.connectionText}>
                {connectionType === "zepp-main" ? "Zepp app" : "Workout extension"}: Connected
              </Text>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={`Disconnect ${
                  connectionType === "zepp-main" ? "Zepp app" : "Workout extension"
                }`}
                onPress={() => onDisconnect(connectionType)}
              >
                <Text style={styles.disconnectText}>Disconnect</Text>
              </TouchableOpacity>
            </View>
          ))
        ) : (
          <Text style={styles.notConnectedText}>No Zepp apps connected</Text>
        )}
        {disconnectError ? <Text style={styles.errorText}>{disconnectError}</Text> : null}
        <TextInput
          style={styles.input}
          value={pairingCode}
          onChangeText={onPairingCodeChange}
          placeholder="Short code"
          placeholderTextColor={colors.textSecondary}
          autoCapitalize="characters"
        />
        <TouchableOpacity
          style={[styles.button, (isPending || !normalizedPairingCode) && styles.buttonDisabled]}
          onPress={onClaimPairing}
          disabled={isPending || !normalizedPairingCode}
          accessibilityRole="button"
          accessibilityLabel="Connect Zepp App"
          accessibilityState={{
            busy: isPending,
            disabled: isPending || !normalizedPairingCode,
          }}
        >
          <Text style={styles.buttonText}>{isPending ? "Connecting..." : "Connect Zepp App"}</Text>
        </TouchableOpacity>
        {pairingMessage ? (
          <Text style={isError ? styles.errorText : styles.successText}>{pairingMessage}</Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
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
  statusTitle: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "600",
    marginBottom: 8,
  },
  connectionRow: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  connectionText: {
    color: colors.text,
    fontSize: 13,
  },
  disconnectText: {
    color: colors.danger,
    fontSize: 12,
    fontWeight: "600",
  },
  notConnectedText: {
    color: colors.textTertiary,
    fontSize: 12,
    marginBottom: 10,
  },
  input: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 12,
    color: colors.text,
    fontSize: 15,
    marginBottom: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  button: {
    alignItems: "center",
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingVertical: 12,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "600",
  },
  errorText: {
    color: colors.danger,
    fontSize: 12,
    marginTop: 8,
  },
  successText: {
    color: colors.accent,
    fontSize: 12,
    marginTop: 8,
  },
});
