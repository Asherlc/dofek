import { useState } from "react";
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { colors } from "../theme";

export interface SupportTicketDraft {
  subject: string;
  message: string;
  email?: string;
}

export function SupportPanel({
  onSubmit,
  onReset,
  isPending,
  errorMessage,
  ticketId,
}: {
  onSubmit: (draft: SupportTicketDraft) => void;
  onReset: () => void;
  isPending: boolean;
  errorMessage?: string | null;
  ticketId?: string | null;
}) {
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");

  function handleSend() {
    const trimmedEmail = email.trim();
    onSubmit({
      subject: subject.trim(),
      message: message.trim(),
      email: trimmedEmail.length > 0 ? trimmedEmail : undefined,
    });
  }

  function handleReset() {
    setSubject("");
    setMessage("");
    setEmail("");
    onReset();
  }

  if (ticketId) {
    return (
      <View style={styles.container}>
        <Text style={styles.successText}>
          Thanks — your request was submitted. Our team will reply by email.
        </Text>
        <Text style={styles.dimText}>Ticket ID: {ticketId}</Text>
        <TouchableOpacity
          style={styles.secondaryButton}
          onPress={handleReset}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Submit another request"
        >
          <Text style={styles.secondaryButtonText}>Submit another request</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const canSubmit = subject.trim().length > 0 && message.trim().length > 0 && !isPending;

  return (
    <View style={styles.container}>
      <Text style={styles.dimText}>
        Have a question or hit a problem? Send us a message and we'll reply by email.
      </Text>

      <Text style={styles.label}>Subject</Text>
      <TextInput
        style={styles.input}
        value={subject}
        onChangeText={setSubject}
        placeholder="Subject"
        placeholderTextColor={colors.textSecondary}
        maxLength={255}
      />

      <Text style={styles.label}>Message</Text>
      <TextInput
        style={[styles.input, styles.multiline]}
        value={message}
        onChangeText={setMessage}
        placeholder="How can we help?"
        placeholderTextColor={colors.textSecondary}
        maxLength={4_000}
        multiline
        numberOfLines={6}
        textAlignVertical="top"
      />

      <Text style={styles.label}>Reply-to email (optional)</Text>
      <TextInput
        style={styles.input}
        value={email}
        onChangeText={setEmail}
        placeholder="Defaults to your account email"
        placeholderTextColor={colors.textSecondary}
        autoCapitalize="none"
        keyboardType="email-address"
      />

      {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}

      <TouchableOpacity
        style={[styles.primaryButton, !canSubmit && styles.buttonDisabled]}
        onPress={handleSend}
        activeOpacity={0.7}
        disabled={!canSubmit}
        accessibilityRole="button"
        accessibilityLabel="Send Message"
        accessibilityState={{ busy: isPending, disabled: !canSubmit }}
      >
        <Text style={styles.primaryButtonText}>{isPending ? "Sending..." : "Send Message"}</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 10,
  },
  label: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.textSecondary,
  },
  input: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 12,
    color: colors.text,
    fontSize: 15,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  multiline: {
    minHeight: 120,
  },
  dimText: {
    fontSize: 13,
    color: colors.textTertiary,
  },
  successText: {
    fontSize: 14,
    color: colors.text,
  },
  errorText: {
    fontSize: 13,
    color: colors.danger,
  },
  primaryButton: {
    alignItems: "center",
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingVertical: 12,
  },
  primaryButtonText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "600",
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  secondaryButton: {
    alignItems: "center",
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 12,
    paddingVertical: 12,
  },
  secondaryButtonText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "600",
  },
});
