import { DEFAULT_DOFEK_SERVER_URL, STORAGE_KEYS } from "../../src/storage-keys.ts";

const EMPTY_STATUS: Record<string, unknown> = {};

function readStatus(raw: string | null): Record<string, unknown> {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : EMPTY_STATUS;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed))
      : EMPTY_STATUS;
  } catch (error) {
    return {
      state: "error",
      reason: `Stored connection status is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

function toggle(
  storage: { getItem(key: string): string | null; setItem(key: string, value: string): void },
  key: string,
) {
  storage.setItem(key, storage.getItem(key) === "1" ? "0" : "1");
}

function buildPairingQrImage(sourceUrl: string): unknown {
  const renderImage: unknown = Reflect.get(globalThis, "Image");
  if (typeof renderImage !== "function") {
    throw new Error("Zepp Settings Image component is unavailable");
  }
  return Reflect.apply(renderImage, undefined, [
    {
      src: sourceUrl,
      alt: "Dofek Workout pairing QR code",
      width: 220,
      height: 220,
      style: { margin: "0 auto 1em", display: "block" },
    },
  ]);
}

interface WorkoutSettingsState {
  serverUrl: string;
  email: string;
  password: string;
  connectionStatus: Record<string, unknown>;
  pairingShortCode: string | null;
  pairingVerificationUrl: string | null;
  pairingQrImageUrl: string | null;
  pairingExpiresAt: string | null;
}

const state: WorkoutSettingsState = {
  serverUrl: DEFAULT_DOFEK_SERVER_URL,
  email: "",
  password: "",
  connectionStatus: EMPTY_STATUS,
  pairingShortCode: null,
  pairingVerificationUrl: null,
  pairingQrImageUrl: null,
  pairingExpiresAt: null,
};

AppSettingsPage({
  state,
  build(props: {
    settingsStorage: {
      getItem(key: string): string | null;
      setItem(key: string, value: string): void;
    };
  }) {
    this.state.serverUrl =
      props.settingsStorage.getItem(STORAGE_KEYS.DOFEK_SERVER_URL) ?? DEFAULT_DOFEK_SERVER_URL;
    this.state.email = props.settingsStorage.getItem(STORAGE_KEYS.DOFEK_EMAIL) ?? "";
    this.state.connectionStatus = readStatus(
      props.settingsStorage.getItem(STORAGE_KEYS.DOFEK_CONNECTION_STATUS),
    );
    this.state.pairingShortCode =
      props.settingsStorage.getItem(STORAGE_KEYS.PAIRING_SHORT_CODE) ?? null;
    this.state.pairingVerificationUrl =
      props.settingsStorage.getItem(STORAGE_KEYS.PAIRING_VERIFICATION_URL) ?? null;
    this.state.pairingQrImageUrl =
      props.settingsStorage.getItem(STORAGE_KEYS.PAIRING_QR_IMAGE_URL) ?? null;
    this.state.pairingExpiresAt =
      props.settingsStorage.getItem(STORAGE_KEYS.PAIRING_EXPIRES_AT) ?? null;

    const connectionState = String(this.state.connectionStatus.state ?? "not connected");
    const connectionReason = this.state.connectionStatus.reason;
    const hasPairingCode = Boolean(
      this.state.pairingShortCode && this.state.pairingVerificationUrl,
    );

    return View({ style: { padding: "1em" } }, [
      View({ style: { fontSize: "1.4rem", fontWeight: "bold", marginBottom: "1em" } }, [
        "Dofek Workout Sync",
      ]),
      TextInput({
        label: "Dofek Server URL",
        value: this.state.serverUrl,
        onChange: (value: string) => {
          this.state.serverUrl = value;
          props.settingsStorage.setItem(STORAGE_KEYS.DOFEK_SERVER_URL, value);
        },
      }),
      Button({
        label: "Create QR / short code",
        color: "primary",
        style: { marginTop: "1em" },
        onClick: () => {
          toggle(props.settingsStorage, STORAGE_KEYS.CMD_START_PAIRING);
        },
      }),
      hasPairingCode
        ? View({ style: { marginTop: "1em", lineHeight: "1.5rem" } }, [
            `Short code: ${this.state.pairingShortCode}`,
            `Open: ${this.state.pairingVerificationUrl}`,
            this.state.pairingExpiresAt
              ? `Expires: ${new Date(this.state.pairingExpiresAt).toLocaleTimeString()}`
              : "",
          ])
        : View({ style: { marginTop: "1em", color: "#888" } }, [
            "Create a code, then scan the QR or enter the code in Dofek.",
          ]),
      this.state.pairingQrImageUrl
        ? buildPairingQrImage(this.state.pairingQrImageUrl)
        : View({}, []),
      TextInput({
        label: "Dofek Email",
        value: this.state.email,
        onChange: (value: string) => {
          this.state.email = value;
          props.settingsStorage.setItem(STORAGE_KEYS.DOFEK_EMAIL, value);
        },
      }),
      TextInput({
        label: "Dofek Password",
        placeholder: "Enter your Dofek password",
        onChange: (value: string) => {
          this.state.password = value;
        },
      }),
      Button({
        label: "Log in and connect",
        color: "primary",
        style: { marginTop: "1em" },
        onClick: () => {
          props.settingsStorage.setItem(
            STORAGE_KEYS.CMD_LOGIN_PASSWORD,
            JSON.stringify({
              email: this.state.email,
              password: this.state.password,
              nonce: Date.now(),
            }),
          );
          this.state.password = "";
        },
      }),
      View({ style: { marginTop: "1em" } }, [
        `Connection: ${connectionState}`,
        connectionReason ? `Reason: ${String(connectionReason)}` : "",
      ]),
      Button({
        label: "Check connection",
        color: "secondary",
        style: { marginTop: "1em" },
        onClick: () => {
          toggle(props.settingsStorage, STORAGE_KEYS.CMD_CHECK_CONNECTION);
        },
      }),
      Button({
        label: "Disconnect Dofek",
        color: "secondary",
        style: { marginTop: "1em" },
        onClick: () => {
          toggle(props.settingsStorage, STORAGE_KEYS.CMD_DISCONNECT);
        },
      }),
      View({ style: { marginTop: "1em", color: "#888" } }, [
        "On the watch, open Workout and choose a workout. Open that workout's settings, select Motion Extensions, then add Dofek Workout.",
        "Live samples are buffered and retried when the phone is unavailable.",
      ]),
    ]);
  },
});
