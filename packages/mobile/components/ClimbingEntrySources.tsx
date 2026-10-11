import { providerSourceLabel } from "@dofek/providers/providers";
import type { ClimbingSourceLink } from "@dofek/training/climbing-context";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { openExternalUrl } from "../lib/open-external-url";
import { colors } from "../theme";

export function ClimbingEntrySources({
  name,
  sourceName,
  links,
}: {
  name: string;
  sourceName: string | null;
  links: ClimbingSourceLink[];
}) {
  const primaryRoute = links.find((link) => link.kind === "route");
  const additionalLinks = links.filter((link) => link !== primaryRoute);
  async function openSource(url: string) {
    if (!(await openExternalUrl(url, "climbing-entry-source"))) {
      Alert.alert("Unable to open source", `Open this source in your browser: ${url}`);
    }
  }
  return (
    <View style={styles.container}>
      {primaryRoute ? (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`${name} on ${providerSourceLabel(primaryRoute.providerId)}`}
          onPress={() => {
            void openSource(primaryRoute.url);
          }}
        >
          <Text style={[styles.name, styles.link]}>{name}</Text>
        </Pressable>
      ) : (
        <Text style={styles.name}>{name}</Text>
      )}
      {sourceName && <Text style={styles.source}>{sourceName}</Text>}
      {additionalLinks.length > 0 && (
        <View style={styles.links}>
          {additionalLinks.map((link) => (
            <Pressable
              key={`${link.providerId}:${link.kind}:${link.url}`}
              accessibilityRole="link"
              accessibilityLabel={
                link.kind === "route"
                  ? `${name} route on ${providerSourceLabel(link.providerId)}`
                  : `${providerSourceLabel(link.providerId)} ticks`
              }
              onPress={() => {
                void openSource(link.url);
              }}
            >
              <Text style={[styles.source, styles.link]}>
                {providerSourceLabel(link.providerId)}
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
