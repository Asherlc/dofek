import { FREQ_MODE_LABELS, STORAGE_KEYS } from "../src/storage-keys.ts";

const EMPTY_RECORD: Record<string, unknown> = {};

function readJson(raw: string | null, fallback: Record<string, unknown>): Record<string, unknown> {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : fallback;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return Object.fromEntries(Object.entries(parsed));
    }
    return fallback;
  } catch {
    // biome-ignore lint/suspicious/noConsole: settings page runs in companion app WebView
    console.error("Failed to parse settings JSON:", raw);
    return fallback;
  }
}

function toggle(
  storage: { getItem(key: string): string | null; setItem(key: string, value: string): void },
  key: string,
) {
  const current = storage.getItem(key);
  storage.setItem(key, current === "1" ? "0" : "1");
}

const PG_STATE: {
  enableGyro: boolean;
  freqModeIndex: number;
  sessionStatus: Record<string, unknown>;
  lastExportPath: string | null;
  transferProgress: Record<string, unknown>;
  dofekServerUrl: string;
  dofekApiToken: string;
  healthSyncStatus: Record<string, unknown>;
  lastHealthSync: string | null;
} = {
  enableGyro: false,
  freqModeIndex: 1,
  sessionStatus: EMPTY_RECORD,
  lastExportPath: null,
  transferProgress: EMPTY_RECORD,
  dofekServerUrl: "",
  dofekApiToken: "",
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
    const rate =
      status.observedHzX100 != null
        ? `${(Number(status.observedHzX100) / 100).toFixed(2)} Hz (measured)`
        : "n/a";

    const healthStatus = this.state.healthSyncStatus;

    const blocks: Array<unknown> = [
      View({ style: { margin: "1em", fontSize: "1.3rem", fontWeight: "bold" } }, ["IMU Logger"]),

      View({ style: { margin: "1em", fontSize: "1.2rem", lineHeight: "1.6rem" } }, [
        `State: ${status.state ?? "idle"}`,
        `Samples: ${status.sampleCount ?? 0}`,
        `Delivered rate: ${rate}`,
        `Gyro in session: ${status.hasGyro ? "yes" : "no"}`,
        `Last export: ${this.state.lastExportPath ?? "none"}`,
      ]),
      TextInput({
        title: "Sample rate mode (0=LOW, 1=NORMAL, 2=HIGH)",
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
      ToggleSwitch({
        label: "Include gyroscope",
        checked: this.state.enableGyro,
        onChange: (checked: boolean) => {
          this.state.enableGyro = checked;
          props.settingsStorage.setItem(STORAGE_KEYS.PREF_ENABLE_GYRO, checked ? "true" : "false");
        },
      }),
      Button({
        label: "Transfer / export watch file",
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

      TextInput({
        title: "Dofek Server URL",
        bold: false,
        value: this.state.dofekServerUrl,
        onChange: (value: string) => {
          this.state.dofekServerUrl = value;
          props.settingsStorage.setItem(STORAGE_KEYS.DOFEK_SERVER_URL, value);
        },
      }),

      TextInput({
        title: "Dofek API Token",
        bold: false,
        placeholder: this.state.dofekApiToken ? "••••••••" : "Paste your companion token",
        onChange: (value: string) => {
          this.state.dofekApiToken = value;
          props.settingsStorage.setItem(STORAGE_KEYS.DOFEK_API_TOKEN, value);
        },
      }),

      Button({
        label: "Sync health data now",
        color: "primary",
        style: { margin: "1em", width: "auto", fontSize: "1.3rem" },
        onClick: () => {
          toggle(props.settingsStorage, STORAGE_KEYS.CMD_SYNC_HEALTH);
        },
      }),

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
    this.state.enableGyro = props.settingsStorage.getItem(STORAGE_KEYS.PREF_ENABLE_GYRO) === "true";
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
    this.state.dofekServerUrl = props.settingsStorage.getItem(STORAGE_KEYS.DOFEK_SERVER_URL) ?? "";
    this.state.dofekApiToken = props.settingsStorage.getItem(STORAGE_KEYS.DOFEK_API_TOKEN) ?? "";
    this.state.healthSyncStatus = readJson(
      props.settingsStorage.getItem(STORAGE_KEYS.HEALTH_SYNC_STATUS),
      {},
    );
    this.state.lastHealthSync =
      props.settingsStorage.getItem(STORAGE_KEYS.LAST_HEALTH_SYNC) ?? null;
  },
});
