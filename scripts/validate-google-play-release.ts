export interface GooglePlayReleaseCredentials {
  serviceAccountJson: string;
  uploadKeyStore: string;
  uploadKeyAlias: string;
  keyStorePassword: string;
  uploadKeyPassword: string;
}

type GooglePlayReleaseEnvironment = Record<string, string | undefined>;

const requiredSecrets = [
  "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64",
  "ANDROID_UPLOAD_KEYSTORE_BASE64",
  "ANDROID_UPLOAD_KEY_ALIAS",
  "ANDROID_UPLOAD_KEYSTORE_PASSWORD",
  "ANDROID_UPLOAD_KEY_PASSWORD",
] as const;

function getRequiredSecret(
  environment: GooglePlayReleaseEnvironment,
  key: (typeof requiredSecrets)[number],
): string {
  const value = environment[key];
  if (!value?.trim()) {
    throw new Error(`Missing required Google Play secret: ${key}`);
  }
  return value;
}

export function validateGooglePlayRelease(
  environment: GooglePlayReleaseEnvironment,
): GooglePlayReleaseCredentials {
  const missingSecrets = requiredSecrets.filter((key) => !environment[key]?.trim());

  if (missingSecrets.length > 0) {
    throw new Error(
      missingSecrets.map((key) => `Missing required Google Play secret: ${key}`).join("\n"),
    );
  }

  return {
    serviceAccountJson: getRequiredSecret(environment, "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64"),
    uploadKeyStore: getRequiredSecret(environment, "ANDROID_UPLOAD_KEYSTORE_BASE64"),
    uploadKeyAlias: getRequiredSecret(environment, "ANDROID_UPLOAD_KEY_ALIAS"),
    keyStorePassword: getRequiredSecret(environment, "ANDROID_UPLOAD_KEYSTORE_PASSWORD"),
    uploadKeyPassword: getRequiredSecret(environment, "ANDROID_UPLOAD_KEY_PASSWORD"),
  };
}
