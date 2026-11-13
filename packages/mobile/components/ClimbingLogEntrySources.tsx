import { providerSourceLabel } from "@dofek/providers/providers";
import type { ClimbingSourceLink } from "@dofek/training/climbing-context";
import type { ClimbKind } from "@dofek/training/climbing-log";
import { selectClimbingSources } from "@dofek/training/climbing-sources";
import type { ReactElement } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { openExternalUrl } from "../lib/open-external-url";
import { SERVER_URL } from "../lib/server";
import { colors } from "../theme";
import { ProviderLogo } from "./ProviderLogo";

export function ClimbingLogEntrySources({
  name,
  climbKind,
  sourceName,
  providerId,
  links,
  selected,
  titleControl,
}: {
  titleControl?: ReactElement;
  name: string;
  climbKind: ClimbKind | null;
  sourceName: string | null;
  providerId?: string;
  links: ClimbingSourceLink[];
  selected?: boolean;
}) {
  const climbLabel = climbKind === "boulder" ? "Problem" : "Route";
  const { primaryRoute, additionalRoutes, sources } = selectClimbingSources(
    sourceName,
    links,
    providerSourceLabel,
  );
  const selectionState = selected === undefined ? undefined : { selected };
  async function openSource(url: string) {
    if (!(await openExternalUrl(url, "climbing-entry-source"))) {
      Alert.alert("Unable to open source", `Open this source in your browser: ${url}`);
    }
  }
  const routeLinks =
    titleControl && primaryRoute ? [primaryRoute, ...additionalRoutes] : additionalRoutes;
  const visibleSources = titleControl
    ? sources.filter(
        ({ label, tickSource }) =>
          tickSource || !routeLinks.some((link) => providerSourceLabel(link.providerId) === label),
      )
    : sources;
  return (
    <View style={styles.container}>
      {titleControl ??
        (primaryRoute ? (
          <Pressable
            accessible
            accessibilityRole="link"
            accessibilityState={selectionState}
            accessibilityLabel={`${name} on ${providerSourceLabel(primaryRoute.providerId)}`}
            onPress={() => {
              void openSource(primaryRoute.url);
            }}
          >
            <Text style={[styles.name, styles.link]}>{name}</Text>
          </Pressable>
        ) : (
          <Text accessible accessibilityState={selectionState} style={styles.name}>
            {name}
          </Text>
        ))}
      <View style={styles.links}>
        {visibleSources.length > 0 && (
          <View style={styles.links}>
            {visibleSources.map(({ label, tickSource }) =>
              tickSource ? (
                <Pressable
                  key={label}
                  accessibilityRole="link"
                  accessibilityLabel={`Climb on ${label}`}
                  style={styles.sourceLink}
                  onPress={() => {
                    void openSource(tickSource.url);
                  }}
                >
                  <Text style={styles.sourceLinkText}>Climb</Text>
                  <ProviderLogo provider={tickSource.providerId} serverUrl={SERVER_URL} size={14} />
                  <Text
                    style={styles.linkCue}
                    accessibilityElementsHidden
                    importantForAccessibility="no"
                  >
                    ↗
                  </Text>
                </Pressable>
              ) : (
                <View key={label} style={styles.links}>
                  {providerId && label === providerSourceLabel(providerId) && (
                    <ProviderLogo provider={providerId} serverUrl={SERVER_URL} size={14} />
                  )}
                  <Text style={styles.source}>{label}</Text>
                </View>
              ),
            )}
          </View>
        )}
        {routeLinks.length > 0 && (
          <View style={styles.links}>
            {routeLinks.map((link) => (
              <Pressable
                key={`${link.providerId}:${link.url}`}
                accessibilityRole="link"
                accessibilityLabel={`${name} ${climbLabel.toLowerCase()} on ${providerSourceLabel(link.providerId)}`}
                style={styles.sourceLink}
                onPress={() => {
                  void openSource(link.url);
                }}
              >
                <Text style={styles.sourceLinkText}>{climbLabel}</Text>
                <ProviderLogo provider={link.providerId} serverUrl={SERVER_URL} size={14} />
                <Text
                  style={styles.linkCue}
                  accessibilityElementsHidden
                  importantForAccessibility="no"
                >
                  ↗
                </Text>
              </Pressable>
            ))}
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 6 },
  name: { color: colors.text, fontSize: 14, fontWeight: "500" },
  source: { color: colors.textSecondary, fontSize: 12 },
  link: { color: colors.accent, textDecorationLine: "underline" },
  sourceLink: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: colors.accentSubtle,
  },
  sourceLinkText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "500",
    lineHeight: 18,
  },
  linkCue: { color: colors.textTertiary, fontSize: 12 },
  links: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
});
