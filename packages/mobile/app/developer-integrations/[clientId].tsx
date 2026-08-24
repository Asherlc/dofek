import type {
  DeveloperClientDetail,
  DeveloperClientInput,
  DeveloperClientSecret,
  DeveloperClientsApi,
} from "@dofek/auth/developer-clients";
import { formatDateTime } from "@dofek/format/format";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { DeveloperClientForm } from "../../components/DeveloperClientForm";
import { DeveloperClientSecretPanel } from "../../components/DeveloperClientSecretPanel";
import { getQueryErrorMessage, QueryStatePanel } from "../../components/QueryStatePanel";
import { useAuth } from "../../lib/auth-context";
import { createMobileDeveloperClientsApi } from "../../lib/developer-clients";
import { colors, fontSize, fontWeight, radius, spacing } from "../../theme";
import { rootStackScreenOptions } from "../_layout-options";

const rotateWarning =
  "The existing secret stops working immediately. Save the replacement before closing its one-time panel.";
const revokeWarning =
  "The client and all active grants stop working immediately. This cannot be undone.";

export interface DeveloperClientDetailScreenViewProps {
  actionError: unknown;
  detail: DeveloperClientDetail | undefined;
  editError: unknown;
  error: unknown;
  isLoading: boolean;
  isRevoking: boolean;
  isRotating: boolean;
  isSaving: boolean;
  onDismissSecret: () => void;
  onEdit: (input: DeveloperClientInput) => void;
  onRevoke: () => void;
  onRotate: () => void;
  rotatedSecret: DeveloperClientSecret | null;
}

export function DeveloperClientDetailScreenView({
  actionError,
  detail,
  editError,
  error,
  isLoading,
  isRevoking,
  isRotating,
  isSaving,
  onDismissSecret,
  onEdit,
  onRevoke,
  onRotate,
  rotatedSecret,
}: DeveloperClientDetailScreenViewProps) {
  if (isLoading && !detail) {
    return (
      <>
        <Stack.Screen options={{ ...rootStackScreenOptions, title: "Developer integration" }} />
        <View style={styles.stateScreen}>
          <QueryStatePanel variant="loading" />
        </View>
      </>
    );
  }

  if (error && !detail) {
    return (
      <>
        <Stack.Screen options={{ ...rootStackScreenOptions, title: "Developer integration" }} />
        <View style={styles.stateScreen}>
          <QueryStatePanel
            variant="error"
            message={getQueryErrorMessage(error, "Could not load the developer integration.")}
          />
        </View>
      </>
    );
  }

  if (!detail) return null;

  const isRevoked = detail.status === "revoked";

  return (
    <>
      <Stack.Screen options={{ ...rootStackScreenOptions, title: detail.name }} />
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>{detail.name}</Text>
          <Text style={styles.clientId}>{detail.clientId}</Text>
          <View style={styles.detailGrid}>
            <Text style={styles.label}>Status</Text>
            <Text style={isRevoked ? styles.revoked : styles.active}>{detail.status}</Text>
            <Text style={styles.label}>Scope</Text>
            <Text style={styles.monospace}>{detail.scopes.join(", ")}</Text>
            <Text style={styles.label}>Created</Text>
            <Text style={styles.value}>{formatDateTime(detail.createdAt)}</Text>
            <Text style={styles.label}>Last rotated</Text>
            <Text style={styles.value}>{formatDateTime(detail.lastRotatedAt)}</Text>
          </View>
          <Text style={styles.label}>Registered redirect URIs</Text>
          {detail.redirectUris.map((redirectUri) => (
            <Text key={redirectUri} selectable style={styles.redirectUri}>
              {redirectUri}
            </Text>
          ))}
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Edit integration</Text>
          {isRevoked ? (
            <Text style={styles.body}>Revoked integrations cannot be changed.</Text>
          ) : null}
          <DeveloperClientForm
            key={JSON.stringify([detail.name, detail.redirectUris])}
            disabled={isRevoked}
            error={isSaving ? null : getQueryErrorMessage(editError, "") || null}
            initialValue={{ name: detail.name, redirectUris: detail.redirectUris }}
            isSubmitting={isSaving}
            onSubmit={onEdit}
            submitLabel="Save integration"
          />
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Credential and access</Text>
          <TouchableOpacity
            accessibilityLabel="Rotate client secret"
            accessibilityRole="button"
            accessibilityState={{ disabled: isRevoked || isRotating }}
            disabled={isRevoked || isRotating}
            onPress={onRotate}
            style={styles.secondaryButton}
          >
            <Text style={styles.secondaryButtonText}>Rotate client secret</Text>
          </TouchableOpacity>
          <TouchableOpacity
            accessibilityLabel="Revoke developer integration"
            accessibilityRole="button"
            accessibilityState={{ disabled: isRevoked || isRevoking }}
            disabled={isRevoked || isRevoking}
            onPress={onRevoke}
            style={styles.dangerButton}
          >
            <Text style={styles.dangerButtonText}>Revoke developer integration</Text>
          </TouchableOpacity>
          {actionError ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {getQueryErrorMessage(actionError)}
            </Text>
          ) : null}
        </View>

        {rotatedSecret ? (
          <DeveloperClientSecretPanel secret={rotatedSecret} onDismiss={onDismissSecret} />
        ) : null}
      </ScrollView>
    </>
  );
}

function DeveloperClientDetailContainer({
  clientId,
  developerClientsApi,
}: {
  clientId: string;
  developerClientsApi: DeveloperClientsApi;
}) {
  const queryClient = useQueryClient();
  const detailQueryKey = ["developer-clients", clientId] as const;
  const [rotatedSecret, setRotatedSecret] = useState<DeveloperClientSecret | null>(null);
  const detail = useQuery({
    queryKey: detailQueryKey,
    queryFn: () => developerClientsApi.get(clientId),
  });

  async function invalidateClientQueries(): Promise<void> {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["developer-clients"] }),
      queryClient.invalidateQueries({ queryKey: detailQueryKey }),
    ]);
  }

  const updateClient = useMutation({
    mutationFn: (input: DeveloperClientInput) =>
      developerClientsApi.update(clientId, {
        name: input.name,
        redirectUris: input.redirectUris,
      }),
    onSuccess: async (updated) => {
      queryClient.setQueryData(detailQueryKey, updated);
      await invalidateClientQueries();
    },
  });
  const rotateClient = useMutation({
    mutationFn: async () => {
      const rotated = await developerClientsApi.rotate(clientId);
      setRotatedSecret(rotated);
      return rotated.client;
    },
    onSuccess: async (rotatedClient) => {
      queryClient.setQueryData(detailQueryKey, rotatedClient);
      await invalidateClientQueries();
    },
  });
  const revokeClient = useMutation({
    mutationFn: () => developerClientsApi.revoke(clientId),
    onSuccess: async () => {
      queryClient.setQueryData<DeveloperClientDetail>(detailQueryKey, (current) =>
        current ? { ...current, status: "revoked" } : current,
      );
      await invalidateClientQueries();
    },
  });

  return (
    <DeveloperClientDetailScreenView
      actionError={rotateClient.error ?? revokeClient.error}
      detail={detail.data}
      editError={updateClient.error}
      error={detail.error}
      isLoading={detail.isLoading}
      isRevoking={revokeClient.isPending}
      isRotating={rotateClient.isPending}
      isSaving={updateClient.isPending}
      onDismissSecret={() => setRotatedSecret(null)}
      onEdit={(input) => updateClient.mutate(input)}
      onRevoke={() =>
        Alert.alert("Revoke developer integration?", revokeWarning, [
          { text: "Cancel", style: "cancel" },
          { text: "Revoke", style: "destructive", onPress: () => revokeClient.mutate() },
        ])
      }
      onRotate={() =>
        Alert.alert("Rotate client secret?", rotateWarning, [
          { text: "Cancel", style: "cancel" },
          { text: "Rotate", style: "destructive", onPress: () => rotateClient.mutate() },
        ])
      }
      rotatedSecret={rotatedSecret}
    />
  );
}

export default function DeveloperClientDetailScreen() {
  const params = useLocalSearchParams<{ clientId?: string | string[] }>();
  const auth = useAuth();
  const developerClientsApi = useMemo(
    () =>
      createMobileDeveloperClientsApi({
        serverUrl: auth.serverUrl,
        sessionToken: auth.sessionToken,
      }),
    [auth.serverUrl, auth.sessionToken],
  );
  const clientId =
    typeof params.clientId === "string" && params.clientId.length > 0 ? params.clientId : null;

  if (!clientId) {
    return (
      <DeveloperClientDetailScreenView
        actionError={null}
        detail={undefined}
        editError={null}
        error={new Error("Developer integration ID is missing.")}
        isLoading={false}
        isRevoking={false}
        isRotating={false}
        isSaving={false}
        onDismissSecret={() => {}}
        onEdit={() => {}}
        onRevoke={() => {}}
        onRotate={() => {}}
        rotatedSecret={null}
      />
    );
  }

  return (
    <DeveloperClientDetailContainer clientId={clientId} developerClientsApi={developerClientsApi} />
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: colors.background, flex: 1 },
  stateScreen: { backgroundColor: colors.background, flex: 1, padding: spacing.md },
  content: { gap: spacing.md, padding: spacing.md, paddingBottom: spacing.xl },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
    padding: spacing.md,
  },
  sectionTitle: { color: colors.text, fontSize: fontSize.lg, fontWeight: fontWeight.bold },
  clientId: { color: colors.textTertiary, fontFamily: "monospace", fontSize: fontSize.xs },
  detailGrid: { gap: spacing.xs },
  label: { color: colors.textSecondary, fontSize: fontSize.xs, fontWeight: fontWeight.semibold },
  value: { color: colors.text, fontSize: fontSize.sm },
  monospace: { color: colors.text, fontFamily: "monospace", fontSize: fontSize.sm },
  active: { color: colors.positive, fontSize: fontSize.sm },
  revoked: { color: colors.textSecondary, fontSize: fontSize.sm },
  redirectUri: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    color: colors.text,
    fontFamily: "monospace",
    fontSize: fontSize.xs,
    padding: spacing.sm,
  },
  body: { color: colors.textSecondary, fontSize: fontSize.sm },
  secondaryButton: {
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.sm,
  },
  secondaryButtonText: { color: colors.text, fontSize: fontSize.sm, textAlign: "center" },
  dangerButton: {
    borderColor: colors.danger,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.sm,
  },
  dangerButtonText: { color: colors.danger, fontSize: fontSize.sm, textAlign: "center" },
  error: { color: colors.danger, fontSize: fontSize.sm },
});
