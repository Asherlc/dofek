import { providerSourceLabel } from "@dofek/providers/providers";
import type { ClimbingSourceLink } from "@dofek/training/climbing-context";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { openExternalUrl } from "../lib/open-external-url";
import { colors } from "../theme";

export function ClimbingLogEntrySources({
  name,
  sourceName,
  links,
  selected,
}: {
  name: string;
  sourceName: string | null;
  links: ClimbingSourceLink[];
  selected?: boolean;
}) {
  const primaryRoute = links.find((link) => link.kind === "route");
  const sources = [
    ...new Set([
      ...(sourceName
        ?.split(",")
        .map((source) => source.trim())
        .filter(Boolean) ?? []),
      ...links.map((link) => providerSourceLabel(link.providerId)),
    ]),
  ];
  const selectionState = selected === undefined ? undefined : { selected };
  async function openSource(url: string) {
    if (!(await openExternalUrl(url, "climbing-entry-source"))) {
      Alert.alert("Unable to open source", `Open this source in your browser: ${url}`);
    }
  }
  return (
    <View style={styles.container}>
      {primaryRoute ? (
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
      )}
      {sources.length > 0 && (
        <View style={styles.links}>
          {sources.map((source) => {
            const tickSource = links.find(
              (link) => link.kind === "ticks" && providerSourceLabel(link.providerId) === source,
            );
            return tickSource ? (
              <Pressable
                key={source}
                accessibilityRole="link"
                accessibilityLabel={source}
                onPress={() => {
                  void openSource(tickSource.url);
                }}
              >
                <Text style={[styles.source, styles.link]}>{source}</Text>
              </Pressable>
            ) : (
              <Text key={source} style={styles.source}>
                {source}
              </Text>
            );
          })}
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
