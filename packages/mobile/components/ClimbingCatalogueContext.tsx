import { providerLabel } from "@dofek/providers/providers";
import type { ClimbingCatalogueContext as Context } from "@dofek/training/climbing-catalogue";
import {
  climbingCatalogueConfidenceLabel,
  climbingCatalogueTagLabel,
} from "@dofek/training/climbing-catalogue";
import { useEffect, useId, useState } from "react";
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

type CatalogueLocation =
  Context["sources"][number]["matches"][number]["candidate"]["locations"][number];

function CatalogueArea({
  location,
  onOpenSource,
}: {
  location: CatalogueLocation;
  onOpenSource: (url: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const area = location.context;
  if (!area || !(area.type || area.sections.length || area.tags.length || area.statistics.length))
    return <Text style={styles.muted}>{location.name}</Text>;
  return (
    <View style={styles.area}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Area information: ${location.name ?? "Unnamed area"}`}
        aria-expanded={open}
        aria-controls={contentId}
        onPress={() => setOpen(!open)}
        style={styles.button}
      >
        <Text style={styles.link}>{location.name ?? "Unnamed area"}</Text>
      </Pressable>
      {open && (
        <View nativeID={contentId} style={styles.areaContent}>
          <Pressable
            accessibilityRole="link"
            onPress={() => onOpenSource(area.url)}
            style={styles.button}
          >
            <Text style={styles.link}>View area on source</Text>
          </Pressable>
          {area.type && <Text style={styles.text}>Area type: {area.type}</Text>}
          {area.sections.map((section) => (
            <View key={section.sourceKey} style={styles.match}>
              <Text accessibilityRole="header" style={styles.heading}>
                {section.label}
              </Text>
              <Text style={styles.text}>{section.text}</Text>
              {section.inheritedFrom && (
                <Text style={styles.muted}>↳ Inherited from {section.inheritedFrom}</Text>
              )}
            </View>
          ))}
          {area.tags.map((tag) => (
            <View key={`${tag.sourceKey}:${tag.label}:${tag.scope}:${tag.inheritedFrom}`}>
              <Text style={styles.text}>
                {tag.label}
                {tag.count !== null ? ` (${tag.count})` : ""}
              </Text>
              {tag.scope === "inherited" && (
                <Text style={styles.muted}>
                  ↳ Inherited{tag.inheritedFrom ? ` from ${tag.inheritedFrom}` : ""}
                </Text>
              )}
            </View>
          ))}
          {area.statistics.map((statistic) => (
            <Text style={styles.text} key={statistic.sourceKey}>
              {statistic.label}: {statistic.value}
            </Text>
          ))}
        </View>
      )}
    </View>
  );
}

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
  const openSource = (url: string) => {
    void Linking.openURL(url).catch((error: unknown) => {
      captureException(error);
      setLinkError(error instanceof Error ? error.message : "Unable to open catalogue source.");
    });
  };
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
        <Text style={styles.heading}>Catalogue information</Text>
      </Pressable>
      {open && (
        <View style={styles.content}>
          {message && (
            <Text accessibilityRole="alert" style={styles.error}>
              {message}
            </Text>
          )}
          {loading && !context && <Text style={styles.text}>Loading climb information…</Text>}
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
                    onPress={() => openSource(candidate.url)}
                    style={styles.button}
                  >
                    <Text style={styles.link}>{candidate.name ?? "View climb"}</Text>
                  </Pressable>
                  {candidate.locations.length > 0 && (
                    <View style={styles.locations}>
                      {candidate.locations.map((location, index) => (
                        <View
                          key={`${location.externalId}:${location.name}:${location.context?.url ?? ""}`}
                          style={styles.location}
                        >
                          {index > 0 && (
                            <Text
                              style={styles.muted}
                              accessibilityElementsHidden
                              importantForAccessibility="no"
                            >
                              ›
                            </Text>
                          )}
                          <CatalogueArea location={location} onOpenSource={openSource} />
                        </View>
                      ))}
                    </View>
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
              <Text style={styles.text}>No catalogue candidates to display.</Text>
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
                  ? "Update climb information"
                  : "Look up climb"}
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
  area: { maxWidth: "100%", flexShrink: 1 },
  areaContent: {
    gap: 8,
    borderLeftWidth: 1,
    borderLeftColor: colors.border,
    paddingLeft: 12,
    paddingBottom: 8,
  },
  locations: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: 4 },
  location: { flexDirection: "row", alignItems: "baseline", columnGap: 4, maxWidth: "100%" },
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
