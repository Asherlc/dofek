import { providerLabel } from "@dofek/providers/providers";
import type { ClimbingCatalogueContext as Context } from "@dofek/training/climbing-catalogue";
import {
  climbingCatalogueConfidenceLabel,
  climbingCatalogueTagLabel,
} from "@dofek/training/climbing-catalogue";
import { useEffect, useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { captureException } from "../lib/telemetry";
import { trpc } from "../lib/trpc";
import { colors } from "../theme";

type Props = {
  context?: Context;
  open: boolean;
  onToggle: () => void;
  onRefresh: () => void;
  loading?: boolean;
  refreshing?: boolean;
  error?: string | null;
};

export function ClimbingCatalogueContextView({
  context,
  open,
  onToggle,
  onRefresh,
  loading,
  refreshing,
  error,
}: Props) {
  const [linkError, setLinkError] = useState<string | null>(null);
  const message = error ?? context?.error ?? linkError;
  const pending = refreshing || (context?.status === "pending" && !message);
  return (
    <View style={styles.container}>
      <Pressable
        accessibilityRole="button"
        aria-expanded={open}
        onPress={onToggle}
        style={styles.button}
      >
        <Text style={styles.heading}>Catalogue context</Text>
      </Pressable>
      {open && (
        <View style={styles.content}>
          <Text style={styles.muted}>Cached reference information</Text>
          {context?.fetchedAt && (
            <Text style={styles.muted}>Fetched {new Date(context.fetchedAt).toLocaleString()}</Text>
          )}
          {message && (
            <Text accessibilityRole="alert" style={styles.error}>
              {message}
            </Text>
          )}
          {loading && !context && <Text style={styles.text}>Loading catalogue context…</Text>}
          {context?.sources.map((source) => (
            <View key={source.providerId} style={styles.content}>
              <Text style={styles.heading}>{providerLabel(source.providerId)}</Text>
              {source.searchArea && (
                <Text style={styles.muted}>Search area: {source.searchArea.name}</Text>
              )}
              {!source.searchComplete && (
                <Text style={styles.muted}>Search incomplete; more candidates may exist.</Text>
              )}
              {source.matches.map(({ candidate, confidence, evidence }) => (
                <View key={candidate.externalId} style={styles.match}>
                  <Text style={styles.muted}>{climbingCatalogueConfidenceLabel(confidence)}</Text>
                  {evidence?.map((reason) => (
                    <Text key={reason} style={styles.muted}>
                      {reason}
                    </Text>
                  ))}
                  <Pressable
                    accessibilityRole="link"
                    onPress={() => {
                      void Linking.openURL(candidate.url).catch((error: unknown) => {
                        captureException(error);
                        setLinkError(
                          error instanceof Error
                            ? error.message
                            : "Unable to open catalogue source.",
                        );
                      });
                    }}
                    style={styles.button}
                  >
                    <Text style={styles.link}>{candidate.name}</Text>
                  </Pressable>
                  {candidate.locations.length > 0 && (
                    <Text style={styles.muted}>
                      {candidate.locations.map((location) => location.name).join(" › ")}
                    </Text>
                  )}
                  {candidate.grade && (
                    <Text style={styles.text}>Catalogue grade: {candidate.grade}</Text>
                  )}
                  {candidate.tags.map((tag) => (
                    <Text
                      style={styles.text}
                      key={`${tag.sourceKey}:${tag.category}:${tag.label}:${tag.scope}:${tag.inheritedFrom}`}
                    >
                      {climbingCatalogueTagLabel(tag)}
                    </Text>
                  ))}
                  {candidate.angle && (
                    <Text style={styles.text}>
                      Source angle: {candidate.angle.value}
                      {candidate.angle.unit === "degrees" ? "°" : " (units not supplied)"}
                    </Text>
                  )}
                </View>
              ))}
            </View>
          ))}
          {context?.status === "ready" &&
            context.sources.every((source) => source.matches.length === 0) && (
              <Text style={styles.text}>
                No catalogue candidates found in the searched sources.
              </Text>
            )}
          {pending ? (
            <Text accessibilityLiveRegion="polite" style={styles.text}>
              Looking up catalogue info…
            </Text>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: loading }}
              disabled={loading}
              onPress={onRefresh}
              style={styles.button}
            >
              <Text style={styles.link}>
                {context && context.status !== "missing"
                  ? "Refresh catalogue info"
                  : "Find catalogue info"}
              </Text>
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}

function OpenCatalogueContext({ id, onToggle }: { id: string; onToggle: () => void }) {
  const utils = trpc.useUtils();
  const query = trpc.climbing.catalogueContext.useQuery(
    { id },
    {
      enabled: true,
      staleTime: 0,
      refetchInterval: (query) =>
        query.state.data?.status === "pending" && !query.state.error ? 1500 : false,
    },
  );
  const [now, setNow] = useState(Date.now);
  const authorizationError = [
    "NOT_FOUND",
    "UNAUTHORIZED",
    "FORBIDDEN",
    "PRECONDITION_FAILED",
  ].includes(query.error?.data?.code ?? "");
  const canDisplay = query.isFetchedAfterMount && !authorizationError;
  const expiresAt = query.data?.expiresAt;
  useEffect(() => {
    if (!canDisplay || !expiresAt) return;
    const remaining = Date.parse(expiresAt) - Date.now();
    if (remaining <= 0) return;
    const timer = setTimeout(() => {
      setNow(Date.now());
      void query.refetch();
    }, remaining);
    return () => clearTimeout(timer);
  }, [canDisplay, expiresAt, query.refetch]);
  const expired = expiresAt != null && Date.parse(expiresAt) <= Math.max(now, Date.now());
  const refresh = trpc.climbing.refreshCatalogueContext.useMutation({
    onSuccess: (context) => utils.climbing.catalogueContext.setData({ id }, context),
  });
  return (
    <ClimbingCatalogueContextView
      context={canDisplay && !expired ? query.data : undefined}
      open={true}
      onToggle={onToggle}
      onRefresh={() => refresh.mutate({ id })}
      loading={query.isLoading || (!query.isFetchedAfterMount && query.isFetching)}
      refreshing={refresh.isPending}
      error={
        authorizationError ? query.error?.message : (refresh.error?.message ?? query.error?.message)
      }
    />
  );
}

const styles = StyleSheet.create({
  container: { borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 8 },
  content: { gap: 12 },
  match: { gap: 4 },
  button: { minHeight: 44, justifyContent: "center" },
  text: { color: colors.text, fontSize: 12 },
  muted: { color: colors.textSecondary, fontSize: 12 },
  heading: { color: colors.text, fontSize: 13, fontWeight: "600" },
  link: { color: colors.accent, fontSize: 12 },
  error: { color: colors.danger, fontSize: 12 },
});

export function ClimbingCatalogueContext({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const onToggle = () => setOpen(!open);
  return open ? (
    <OpenCatalogueContext id={id} onToggle={onToggle} />
  ) : (
    <ClimbingCatalogueContextView open={false} onToggle={onToggle} onRefresh={() => {}} />
  );
}
