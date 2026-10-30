import { providerSourceLabel } from "@dofek/providers/providers";
import type { ClimbingSourceLink } from "@dofek/training/climbing-context";
import { selectClimbingSources } from "@dofek/training/climbing-sources";
import type { ReactNode } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { openExternalUrl } from "../lib/open-external-url";
import { colors } from "../theme";

export function ClimbingLogEntrySources({
  name,
  sourceName,
  links,
  selected,
  titleControl,
}: {
  titleControl?: ReactNode;
  name: string;
  sourceName: string | null;
  links: ClimbingSourceLink[];
  selected?: boolean;
}) {
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
      {visibleSources.length > 0 && (
        <View style={styles.links}>
          {visibleSources.map(({ label, tickSource }) =>
            tickSource ? (
              <Pressable
                key={label}
                accessibilityRole="link"
                accessibilityLabel={label}
                onPress={() => {
                  void openSource(tickSource.url);
                }}
              >
                <Text style={[styles.source, styles.link]}>{label}</Text>
              </Pressable>
            ) : (
              <Text key={label} style={styles.source}>
                {label}
              </Text>
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
              accessibilityLabel={`${name} route on ${providerSourceLabel(link.providerId)}`}
              onPress={() => {
                void openSource(link.url);
              }}
            >
              <Text style={[styles.source, styles.link]}>
                Route on {providerSourceLabel(link.providerId)}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 3 },
  name: { color: colors.text, fontSize: 14, fontWeight: "500" },
  source: { color: colors.textSecondary, fontSize: 12 },
  link: { color: colors.accent, textDecorationLine: "underline" },
  links: { flexDirection: "row", flexWrap: "wrap", columnGap: 12, rowGap: 8 },
});
