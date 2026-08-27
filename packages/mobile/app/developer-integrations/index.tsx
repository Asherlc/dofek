import type {
  DeveloperClientInput,
  DeveloperClientSecret,
  DeveloperClientSummary,
} from "@dofek/auth/developer-clients";
import { formatDateTime } from "@dofek/format/format";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Stack, useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { DeveloperClientForm } from "../../components/DeveloperClientForm";
import { DeveloperClientSecretPanel } from "../../components/DeveloperClientSecretPanel";
import { getQueryErrorMessage, QueryStatePanel } from "../../components/QueryStatePanel";
import { useAuth } from "../../lib/auth-context";
import { createMobileDeveloperClientsApi } from "../../lib/developer-clients";
import { openExternalUrl } from "../../lib/open-external-url";
import { colors, fontSize, fontWeight, radius, spacing } from "../../theme";
import { rootStackScreenOptions } from "../_layout-options";

const externalApiDocsUrl = "https://github.com/Asherlc/dofek/blob/main/docs/external-api.md";

export interface DeveloperIntegrationsScreenContentProps {
  clients: DeveloperClientSummary[] | undefined;
  createError: unknown;
  createdSecret: DeveloperClientSecret | null;
  isCreating: boolean;
  isLoading: boolean;
  listError: unknown;
  onCreate: (input: DeveloperClientInput) => void;
  onDismissSecret: () => void;
  onOpenDetail: (clientId: string) => void;
  onOpenDocs: () => void;
}

export function DeveloperIntegrationsScreenContent({
  clients,
  createError,
  createdSecret,
  isCreating,
  isLoading,
  listError,
  onCreate,
  onDismissSecret,
  onOpenDetail,
  onOpenDocs,
}: DeveloperIntegrationsScreenContentProps) {
  return (
    <>
      <Stack.Screen options={{ ...rootStackScreenOptions, title: "Developer integrations" }} />
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>How authorization works</Text>
          <Text style={styles.body}>
            Your integration sends users through Dofek sign-in and consent. Keep the Proof Key for
            Code Exchange (PKCE) verifier in your integration and send the bearer client credential
            only in the Authorization header.
          </Text>
          <TouchableOpacity
            accessibilityLabel="External API contract"
            accessibilityRole="button"
            onPress={onOpenDocs}
          >
            <Text style={styles.link}>External API contract</Text>
          </TouchableOpacity>
          <Text selectable style={styles.code}>{`POST /api/external/v1/link/start
Authorization: Bearer <client-id>.<client-secret>
requestedScopes: nutrition:write
codeChallenge: <S256-challenge>`}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Your integrations</Text>
          {isLoading && clients === undefined ? (
            <QueryStatePanel variant="loading" />
          ) : listError && clients === undefined ? (
            <QueryStatePanel
              variant="error"
              message={getQueryErrorMessage(listError, "Could not load developer integrations.")}
            />
          ) : (
            <>
              {listError ? (
                <QueryStatePanel
                  variant="error"
                  minHeight={80}
                  title="Could not refresh developer integrations"
                  message={getQueryErrorMessage(listError)}
                />
              ) : null}
              {clients?.length === 0 ? (
                <QueryStatePanel
                  variant="empty"
                  message="No developer integrations yet."
                  minHeight={100}
                />
              ) : (
                clients?.map((client) => (
                  <TouchableOpacity
                    key={client.clientId}
                    accessibilityLabel={`Open ${client.name}`}
                    accessibilityRole="button"
                    onPress={() => onOpenDetail(client.clientId)}
                    style={styles.clientCard}
                  >
                    <View style={styles.clientHeader}>
                      <View style={styles.clientTitleGroup}>
                        <Text style={styles.clientName}>{client.name}</Text>
                        <Text style={styles.clientId}>{client.clientId}</Text>
                      </View>
                      <Text style={client.status === "active" ? styles.active : styles.revoked}>
                        {client.status}
                      </Text>
                    </View>
                    <Text style={styles.meta}>Scope: {client.scopes.join(", ")}</Text>
                    <Text style={styles.meta}>Created {formatDateTime(client.createdAt)}</Text>
                    <Text style={styles.meta}>
                      Last rotated {formatDateTime(client.lastRotatedAt)}
                    </Text>
                  </TouchableOpacity>
                ))
              )}
            </>
          )}
        </View>

        {createdSecret ? (
          <DeveloperClientSecretPanel secret={createdSecret} onDismiss={onDismissSecret} />
        ) : null}

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Create an integration</Text>
          <Text style={styles.body}>
            Register every callback URI exactly as your integration will send it.
          </Text>
          <DeveloperClientForm
            error={createError ? getQueryErrorMessage(createError) : null}
            isSubmitting={isCreating}
            onSubmit={onCreate}
          />
        </View>
      </ScrollView>
    </>
  );
}

export default function DeveloperIntegrationsScreen() {
  const auth = useAuth();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [createdSecret, setCreatedSecret] = useState<DeveloperClientSecret | null>(null);
  const developerClientsApi = useMemo(
    () =>
      createMobileDeveloperClientsApi({
        serverUrl: auth.serverUrl,
        sessionToken: auth.sessionToken,
      }),
    [auth.serverUrl, auth.sessionToken],
  );
  const clients = useQuery({
    queryKey: ["developer-clients"],
    queryFn: () => developerClientsApi.list(),
  });
  const createClient = useMutation({
    mutationFn: async (input: DeveloperClientInput) => {
      const secret = await developerClientsApi.create(input);
      setCreatedSecret(secret);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["developer-clients"] });
    },
  });

  return (
    <DeveloperIntegrationsScreenContent
      clients={clients.data}
      createError={createClient.error}
      createdSecret={createdSecret}
      isCreating={createClient.isPending}
      isLoading={clients.isLoading}
      listError={clients.error}
      onCreate={(input) => createClient.mutate(input)}
      onDismissSecret={() => setCreatedSecret(null)}
      onOpenDetail={(clientId) => router.push(`/developer-integrations/${clientId}`)}
      onOpenDocs={() => void openExternalUrl(externalApiDocsUrl, "developer-integrations")}
    />
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: colors.background, flex: 1 },
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
  body: { color: colors.textSecondary, fontSize: fontSize.sm },
  link: { color: colors.accent, fontSize: fontSize.sm, fontWeight: fontWeight.semibold },
  code: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    color: colors.text,
    fontFamily: "monospace",
    fontSize: fontSize.xs,
    padding: spacing.sm,
  },
  clientCard: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.lg,
    gap: spacing.xs,
    padding: spacing.md,
  },
  clientHeader: { alignItems: "flex-start", flexDirection: "row", gap: spacing.sm },
  clientTitleGroup: { flex: 1 },
  clientName: { color: colors.text, fontSize: fontSize.base, fontWeight: fontWeight.semibold },
  clientId: { color: colors.textTertiary, fontFamily: "monospace", fontSize: fontSize.xs },
  active: { color: colors.positive, fontSize: fontSize.xs },
  revoked: { color: colors.textSecondary, fontSize: fontSize.xs },
  meta: { color: colors.textSecondary, fontSize: fontSize.xs },
});
