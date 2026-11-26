import * as WebBrowser from "expo-web-browser";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { captureException } from "../lib/telemetry";
import { colors } from "../theme";
import { styles as settingsStyles } from "./settings.styles";

const APPLE_STANDARD_EULA_URL = "https://www.apple.com/legal/internet-services/itunes/dev/stdeula/";

export const DOFEK_PREMIUM_MONTHLY_TITLE = "Dofek Premium Monthly";

type BillingLegalDocument = "privacy" | "terms";

export function BillingPurchaseProductSummary({
  productTitle,
  productLoading,
  priceUnavailable,
}: {
  productTitle: string;
  productLoading: boolean;
  priceUnavailable: boolean;
}) {
  return (
    <View style={styles.productSummary}>
      <Text style={styles.productTitle}>{productTitle}</Text>
      {productLoading ? (
        <Text style={styles.detailText}>Loading App Store price...</Text>
      ) : priceUnavailable ? (
        <Text style={styles.errorText}>App Store price is unavailable. Try again later.</Text>
      ) : null}
    </View>
  );
}

export function BillingPurchaseLegalLinks({
  privacyPolicyUrl,
  onError,
}: {
  privacyPolicyUrl: string;
  onError: (message: string) => void;
}) {
  async function handleOpen(document: BillingLegalDocument): Promise<void> {
    const documentTitle = document === "privacy" ? "Privacy Policy" : "Terms of Use (EULA)";
    try {
      await WebBrowser.openBrowserAsync(
        document === "privacy" ? privacyPolicyUrl : APPLE_STANDARD_EULA_URL,
      );
    } catch (error: unknown) {
      captureException(error, {
        source: "settings-billing-open-legal-document",
        document,
        operation: "WebBrowser.openBrowserAsync",
      });
      onError(`Could not open the ${documentTitle}. Try again.`);
    }
  }

  return (
    <View style={styles.legalRow}>
      <TouchableOpacity
        accessibilityLabel="Terms of Use (EULA)"
        accessibilityRole="link"
        activeOpacity={0.7}
        onPress={() => void handleOpen("terms")}
      >
        <Text style={styles.legalLink}>Terms of Use (EULA)</Text>
      </TouchableOpacity>
      <TouchableOpacity
        accessibilityLabel="Privacy Policy"
        accessibilityRole="link"
        activeOpacity={0.7}
        onPress={() => void handleOpen("privacy")}
      >
        <Text style={styles.legalLink}>Privacy Policy</Text>
      </TouchableOpacity>
    </View>
  );
}

export function BillingSubscribeButton({
  displayPrice,
  isSubscribing,
  disabled,
  onPress,
}: {
  displayPrice: string | undefined;
  isSubscribing: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const label = isSubscribing
    ? "Subscribing..."
    : displayPrice
      ? `Subscribe for ${displayPrice}/month`
      : "Subscribe";
  return (
    <TouchableOpacity
      style={[settingsStyles.billingPrimaryButton, disabled && settingsStyles.buttonDisabled]}
      onPress={onPress}
      activeOpacity={0.7}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ busy: isSubscribing, disabled }}
    >
      <Text style={settingsStyles.billingButtonText}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  productSummary: {
    gap: 4,
    marginBottom: 12,
  },
  productTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "700",
  },
  detailText: {
    color: colors.textSecondary,
    fontSize: 13,
    marginBottom: 8,
  },
  errorText: {
    color: colors.danger,
    fontSize: 12,
    marginBottom: 8,
  },
  legalRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 16,
    marginTop: 12,
  },
  legalLink: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: "600",
  },
});
