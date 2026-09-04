import { deriveConnectionActions, parseConnectionState } from "../src/connection-state.ts";
import { getSessionAction, parseSessionState, SESSION_COMMAND } from "../src/session-control.ts";
import { DEFAULT_DOFEK_SERVER_URL, FREQ_MODE_LABELS, STORAGE_KEYS } from "../src/storage-keys.ts";

const EMPTY_RECORD: Record<string, unknown> = {};

function readJson(raw: string | null, fallback: Record<string, unknown>): Record<string, unknown> {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : fallback;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return Object.fromEntries(Object.entries(parsed));
    }
    return fallback;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...fallback,
      state: "error",
      reason: `Stored settings data is invalid: ${message}`,
    };
  }
}

function toggle(
  storage: { getItem(key: string): string | null; setItem(key: string, value: string): void },
  key: string,
) {
  const current = storage.getItem(key);
  storage.setItem(key, current === "1" ? "0" : "1");
}

function buildPairingQrImage(sourceUrl: string): unknown {
  const renderImage: unknown = Reflect.get(globalThis, "Image");
  if (typeof renderImage !== "function") {
    throw new Error("Zepp Settings Image component is unavailable");
  }
  return Reflect.apply(renderImage, undefined, [
    {
      src: sourceUrl,
      alt: "Dofek pairing QR code",
      width: 220,
      height: 220,
      style: { margin: "0 auto 1em", display: "block" },
    },
  ]);
}

const PG_STATE: {
  freqModeIndex: number;
  sessionStatus: Record<string, unknown>;
  lastExportPath: string | null;
  transferProgress: Record<string, unknown>;
  dofekServerUrl: string;
  dofekEmail: string;
  dofekPassword: string;
  dofekApiToken: string;
  connectionStatus: Record<string, unknown>;
  pairingShortCode: string | null;
  pairingVerificationUrl: string | null;
  pairingQrImageUrl: string | null;
  pairingExpiresAt: string | null;
  healthSyncStatus: Record<string, unknown>;
  lastHealthSync: string | null;
} = {
  freqModeIndex: 1,
  sessionStatus: EMPTY_RECORD,
  lastExportPath: null,
  transferProgress: EMPTY_RECORD,
  dofekServerUrl: "",
  dofekEmail: "",
  dofekPassword: "",
  dofekApiToken: "",
  connectionStatus: EMPTY_RECORD,
  pairingShortCode: null,
  pairingVerificationUrl: null,
  pairingQrImageUrl: null,
  pairingExpiresAt: null,
  healthSyncStatus: EMPTY_RECORD,
  lastHealthSync: null,
};

AppSettingsPage({
  state: PG_STATE,

  build(props: {
    settingsStorage: {
      getItem(key: string): string | null;
      setItem(key: string, value: string): void;
    };
  }) {
    this.loadState(props);

    const status = this.state.sessionStatus;
    const sessionAction = getSessionAction(parseSessionState(status.state));
    const rate =
      status.observedHzX100 != null
        ? `${(Number(status.observedHzX100) / 100).toFixed(2)} Hz (measured)`
        : "n/a";

    const healthStatus = this.state.healthSyncStatus;
    const connectionStatus = this.state.connectionStatus;
    const connectionState = parseConnectionState(connectionStatus.state);
    const connectionActions = deriveConnectionActions(
      connectionState,
      Boolean(this.state.dofekApiToken.trim()),
    );
    const hasPairingCode = Boolean(
      this.state.pairingShortCode && this.state.pairingVerificationUrl,
    );

    const blocks: Array<unknown> = [
      View({ style: { margin: "1em", fontSize: "1.3rem", fontWeight: "bold" } }, [
        "Advanced Foreground Recorder",
      ]),

      View({ style: { margin: "1em", fontSize: "1.2rem", lineHeight: "1.6rem" } }, [
        `State: ${status.state ?? "idle"}`,
        `Samples: ${status.sampleCount ?? 0}`,
        `Delivered rate: ${rate}`,
        `Gyro in session: ${status.hasGyro ? "yes" : "no"}`,
        `Last export: ${this.state.lastExportPath ?? "none"}`,
      ]),
      Button({
        label: `${sessionAction.label} on watch`,
        color: sessionAction.command === SESSION_COMMAND.START ? "primary" : "secondary",
        style: { margin: "1em", width: "auto", fontSize: "1.3rem" },
        onClick: () => {
          props.settingsStorage.setItem(STORAGE_KEYS.CMD_LOGGING, sessionAction.command);
        },
      }),
      View({ style: { margin: "0 1em 1em", fontSize: "1rem", color: "#888" } }, [
        "Keep the Dofek watch app open for the entire recording. Gyroscope data is included automatically when the watch supports it.",
      ]),
      TextInput({
        label: "Sample rate mode (0=LOW, 1=NORMAL, 2=HIGH)",
        bold: false,
        value: String(this.state.freqModeIndex),
        onChange: (value: string) => {
          const parsed = Number(value);
          if (parsed >= 0 && parsed <= 2) {
            this.state.freqModeIndex = parsed;
            props.settingsStorage.setItem(STORAGE_KEYS.PREF_FREQ_MODE, String(parsed));
          }
        },
      }),
      View({ style: { margin: "0 1em", fontSize: "1rem", color: "#888" } }, [
        `Requested: ${FREQ_MODE_LABELS[this.state.freqModeIndex]}. Docs do not publish Hz per mode; the watch records the delivered rate.`,
      ]),
      Button({
        label: "Transfer finalized session",
        color: "primary",
        style: { margin: "1em", width: "auto", fontSize: "1.3rem" },
        onClick: () => {
          toggle(props.settingsStorage, STORAGE_KEYS.CMD_TRANSFER);
        },
      }),
    ];

    if (this.state.transferProgress.state) {
      blocks.push(
        View({ style: { margin: "1em", fontSize: "1.1rem" } }, [
          `Transfer: ${this.state.transferProgress.state}`,
          this.state.transferProgress.pct != null
            ? `Progress: ${this.state.transferProgress.pct}%`
            : "",
        ]),
      );
    }

    // Dofek Health Sync Section
    blocks.push(
      View({ style: { margin: "1em", fontSize: "1.3rem", fontWeight: "bold" } }, [
        "Dofek Health Sync",
      ]),
      View(
        {
          style: {
            margin: "0 1em 1em",
            fontSize: "1rem",
            color: connectionState === "connected" ? "#2ecc71" : "#e67e22",
            fontWeight: "bold",
          },
        },
        [
          connectionState === "connected"
            ? "● Connected — verified by Dofek"
            : `○ Connection: ${connectionState}`,
        ],
      ),
      View({ style: { margin: "0 1em 1em", fontSize: "1.1rem", lineHeight: "1.5rem" } }, [
        `Connection: ${connectionState}`,
        connectionStatus.reason ? `Reason: ${String(connectionStatus.reason)}` : "",
      ]),
    );

    if (connectionActions.showConnectionForm) {
      blocks.push(
        TextInput({
          label: "Dofek Server URL",
          bold: false,
          value: this.state.dofekServerUrl,
          onChange: (value: string) => {
            this.state.dofekServerUrl = value;
            props.settingsStorage.setItem(STORAGE_KEYS.DOFEK_SERVER_URL, value);
          },
        }),
      );
    }

    if (connectionActions.showPairing) {
      blocks.push(
        Button({
          label: "Create QR / short code",
          color: "primary",
          style: { margin: "1em", width: "auto", fontSize: "1.3rem" },
          onClick: () => {
            toggle(props.settingsStorage, STORAGE_KEYS.CMD_START_PAIRING);
          },
        }),
      );
    }

    if (connectionActions.showPairing || connectionState === "pairing") {
      blocks.push(
        hasPairingCode
          ? View({ style: { margin: "1em", fontSize: "1.1rem", lineHeight: "1.5rem" } }, [
              `Short code: ${this.state.pairingShortCode}`,
              this.state.pairingVerificationUrl ? `Open: ${this.state.pairingVerificationUrl}` : "",
              this.state.pairingExpiresAt
                ? `Expires: ${new Date(this.state.pairingExpiresAt).toLocaleTimeString()}`
                : "",
            ])
          : View({ style: { margin: "0 1em 1em", fontSize: "1.1rem", color: "#888" } }, [
              "Create a code, then scan the QR or enter the code in Dofek.",
            ]),

        this.state.pairingQrImageUrl
          ? buildPairingQrImage(this.state.pairingQrImageUrl)
          : View({}, []),
      );
    }

    if (connectionActions.showLogin) {
      blocks.push(
        TextInput({
          label: "Dofek Email",
          bold: false,
          value: this.state.dofekEmail,
          onChange: (value: string) => {
            this.state.dofekEmail = value;
            props.settingsStorage.setItem(STORAGE_KEYS.DOFEK_EMAIL, value);
          },
        }),

        TextInput({
          label: "Dofek Password",
          bold: false,
          placeholder: "Enter your Dofek password",
          onChange: (value: string) => {
            this.state.dofekPassword = value;
          },
        }),

        Button({
          label: "Log in and connect",
          color: "primary",
          style: { margin: "1em", width: "auto", fontSize: "1.3rem" },
          onClick: () => {
            props.settingsStorage.setItem(STORAGE_KEYS.DOFEK_EMAIL, this.state.dofekEmail);
            props.settingsStorage.setItem(
              STORAGE_KEYS.CMD_LOGIN_PASSWORD,
              JSON.stringify({
                email: this.state.dofekEmail,
                password: this.state.dofekPassword,
                nonce: Date.now(),
              }),
            );
            this.state.dofekPassword = "";
          },
        }),
      );
    }

    if (connectionActions.showCheck) {
      blocks.push(
        Button({
          label: "Check connection",
          color: "secondary",
          style: { margin: "1em", width: "auto", fontSize: "1.3rem" },
          onClick: () => {
            toggle(props.settingsStorage, STORAGE_KEYS.CMD_CHECK_CONNECTION);
          },
        }),
      );
    }

    if (connectionActions.showDisconnect) {
      blocks.push(
        Button({
          label: "Disconnect Dofek",
          color: "secondary",
          style: { margin: "1em", width: "auto", fontSize: "1.3rem" },
          onClick: () => {
            toggle(props.settingsStorage, STORAGE_KEYS.CMD_DISCONNECT);
          },
        }),
      );
    }

    if (connectionActions.showSync) {
      blocks.push(
        Button({
          label: "Sync health data now",
          color: "primary",
          style: { margin: "1em", width: "auto", fontSize: "1.3rem" },
          onClick: () => {
            toggle(props.settingsStorage, STORAGE_KEYS.CMD_SYNC_HEALTH);
          },
        }),
      );
    }

    blocks.push(
      View({ style: { margin: "1em", fontSize: "1.1rem", lineHeight: "1.5rem" } }, [
        `Status: ${String(healthStatus.state ?? "idle")}`,
        healthStatus.reason ? `Reason: ${String(healthStatus.reason)}` : "",
        this.state.lastHealthSync
          ? `Last sync: ${new Date(Number(this.state.lastHealthSync)).toLocaleString()}`
          : "Not synced yet",
      ]),
    );

    return View({}, blocks);
  },

  loadState(props: {
    settingsStorage: {
      getItem(key: string): string | null;
      setItem(key: string, value: string): void;
    };
  }) {
    this.state.freqModeIndex = Number(
      props.settingsStorage.getItem(STORAGE_KEYS.PREF_FREQ_MODE) ?? 1,
    );
    this.state.sessionStatus = readJson(
      props.settingsStorage.getItem(STORAGE_KEYS.SESSION_STATUS),
      {},
    );
    this.state.lastExportPath =
      props.settingsStorage.getItem(STORAGE_KEYS.LAST_EXPORT_PATH) ?? null;
    this.state.transferProgress = readJson(
      props.settingsStorage.getItem(STORAGE_KEYS.TRANSFER_PROGRESS),
      {},
    );
    this.state.dofekServerUrl =
      props.settingsStorage.getItem(STORAGE_KEYS.DOFEK_SERVER_URL) ?? DEFAULT_DOFEK_SERVER_URL;
    this.state.dofekEmail = props.settingsStorage.getItem(STORAGE_KEYS.DOFEK_EMAIL) ?? "";
    this.state.dofekApiToken = props.settingsStorage.getItem(STORAGE_KEYS.DOFEK_API_TOKEN) ?? "";
    this.state.connectionStatus = readJson(
      props.settingsStorage.getItem(STORAGE_KEYS.DOFEK_CONNECTION_STATUS),
      {},
    );
    this.state.pairingShortCode =
      props.settingsStorage.getItem(STORAGE_KEYS.PAIRING_SHORT_CODE) ?? null;
    this.state.pairingVerificationUrl =
      props.settingsStorage.getItem(STORAGE_KEYS.PAIRING_VERIFICATION_URL) ?? null;
    this.state.pairingQrImageUrl =
      props.settingsStorage.getItem(STORAGE_KEYS.PAIRING_QR_IMAGE_URL) ?? null;
    this.state.pairingExpiresAt =
      props.settingsStorage.getItem(STORAGE_KEYS.PAIRING_EXPIRES_AT) ?? null;
    this.state.healthSyncStatus = readJson(
      props.settingsStorage.getItem(STORAGE_KEYS.HEALTH_SYNC_STATUS),
      {},
    );
    this.state.lastHealthSync =
      props.settingsStorage.getItem(STORAGE_KEYS.LAST_HEALTH_SYNC) ?? null;
  },
});
