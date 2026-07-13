import { useState } from "react";
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { trpc } from "../lib/trpc";
import { colors } from "../theme";

interface ZeppPairingCardBodyProps {
  pairingCode: string;
  pairingMessage: string;
  isError: boolean;
  isPending: boolean;
  onPairingCodeChange: (value: string) => void;
  onClaimPairing: () => void;
}

export function ZeppPairingCard() {
  const [pairingCode, setPairingCode] = useState("");
  const [pairingMessage, setPairingMessage] = useState("");
  const pairingMutation = trpc.companionPairing.claim.useMutation({
    onMutate: () => {
      setPairingMessage("");
    },
    onSuccess: () => {
      setPairingCode("");
      setPairingMessage("Zepp app connected. Return to Zepp to sync.");
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
      pairingCode={pairingCode}
      pairingMessage={pairingMessage}
      isError={pairingMutation.isError}
      isPending={pairingMutation.isPending}
      onPairingCodeChange={(value) => {
        setPairingCode(value);
        setPairingMessage("");
      }}
      onClaimPairing={handleClaimPairing}
    />
  );
}

export function ZeppPairingCardBody({
  pairingCode,
  pairingMessage,
  isError,
  isPending,
  onPairingCodeChange,
  onClaimPairing,
}: ZeppPairingCardBodyProps) {
  const normalizedPairingCode = pairingCode.trim();

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Zepp App Pairing</Text>
      <Text style={styles.sectionDescription}>Connect the Zepp watch app to this account</Text>
      <View style={styles.card}>
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
