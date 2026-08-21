import { formatDateTime } from "@dofek/format/format";
import { providerAbsentExplanation, providerSourceLabel } from "@dofek/providers/providers";
import { Text, View } from "react-native";
import { styles } from "./styles";

interface ProviderAbsentBannerActivity {
  providerId: string;
  subsource?: string | null;
  providerAbsentAt: Date | string | null;
}

export function ProviderAbsentBanner({ activity }: { activity: ProviderAbsentBannerActivity }) {
  return (
    <View style={styles.providerAbsentBanner}>
      <Text style={styles.providerAbsentTitle}>Removed from provider sync</Text>
      <View style={styles.providerAbsentDetails}>
        <View style={styles.providerAbsentDetail}>
          <Text style={styles.providerAbsentLabel}>Status</Text>
          <Text style={styles.providerAbsentValue}>Removed</Text>
        </View>
        <View style={styles.providerAbsentDetail}>
          <Text style={styles.providerAbsentLabel}>Provider</Text>
          <Text style={styles.providerAbsentValue}>
            {providerSourceLabel(activity.providerId, activity.subsource)}
          </Text>
        </View>
        <View style={styles.providerAbsentDetail}>
          <Text style={styles.providerAbsentLabel}>Removed at</Text>
          <Text style={styles.providerAbsentValue}>
            {activity.providerAbsentAt ? formatDateTime(activity.providerAbsentAt) : "—"}
          </Text>
        </View>
      </View>
      <Text style={styles.providerAbsentExplanation}>
        {providerAbsentExplanation(activity.providerId, activity.subsource)}
      </Text>
    </View>
  );
}
