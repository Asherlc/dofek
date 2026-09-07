import { describe, expect, it } from "vitest";
import { renderSettingsInSandbox } from "../../setting/test-helpers.ts";
import { STORAGE_KEYS } from "../../src/storage-keys.ts";

describe("Workout Extension Settings entry point", () => {
  it("renders a saved pairing QR in Zepp's restricted Settings sandbox", async () => {
    const images = await renderSettingsInSandbox(new URL("./index.ts", import.meta.url), {
      [STORAGE_KEYS.PAIRING_SHORT_CODE]: "ABC234",
      [STORAGE_KEYS.PAIRING_VERIFICATION_URL]:
        "https://dofek.example.test/zepp-pairing?code=ABC234",
      [STORAGE_KEYS.PAIRING_QR_IMAGE_URL]: "https://dofek.example.test/pairing.svg",
      [STORAGE_KEYS.PAIRING_EXPIRES_AT]: "2999-01-01T00:00:00.000Z",
      [STORAGE_KEYS.DOFEK_CONNECTION_STATUS]: JSON.stringify({ state: "pairing" }),
    });

    expect(images).toEqual([
      expect.objectContaining({
        src: "https://dofek.example.test/pairing.svg",
        alt: "Dofek Workout pairing QR code",
      }),
    ]);
  });
});
