import { describe, expect, it } from "vitest";

import { validateGooglePlayRelease } from "./validate-google-play-release";

describe("validateGooglePlayRelease", () => {
  it("names each missing Google Play secret", () => {
    expect(() => validateGooglePlayRelease({})).toThrow(
      "Missing required Google Play secret: GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64",
    );
    expect(() => validateGooglePlayRelease({})).toThrow(
      "Missing required Google Play secret: ANDROID_UPLOAD_KEYSTORE_BASE64",
    );
    expect(() => validateGooglePlayRelease({})).toThrow(
      "Missing required Google Play secret: ANDROID_UPLOAD_KEY_ALIAS",
    );
    expect(() => validateGooglePlayRelease({})).toThrow(
      "Missing required Google Play secret: ANDROID_UPLOAD_KEYSTORE_PASSWORD",
    );
    expect(() => validateGooglePlayRelease({})).toThrow(
      "Missing required Google Play secret: ANDROID_UPLOAD_KEY_PASSWORD",
    );
  });

  it("returns every validated release credential", () => {
    expect(
      validateGooglePlayRelease({
        GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64: "service-account",
        ANDROID_UPLOAD_KEYSTORE_BASE64: "keystore",
        ANDROID_UPLOAD_KEY_ALIAS: "upload",
        ANDROID_UPLOAD_KEYSTORE_PASSWORD: "keystore-password",
        ANDROID_UPLOAD_KEY_PASSWORD: "key-password",
      }),
    ).toEqual({
      serviceAccountJson: "service-account",
      uploadKeyStore: "keystore",
      uploadKeyAlias: "upload",
      keyStorePassword: "keystore-password",
      uploadKeyPassword: "key-password",
    });
  });
});
