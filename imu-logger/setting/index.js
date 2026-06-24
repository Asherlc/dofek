import {
  FREQ_MODE_LABELS,
  LOGGING_CMD,
  STORAGE_KEYS,
} from "../utils/storage-keys";

function readJson(raw, fallback) {
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch (error) {
    return fallback;
  }
}

function toggle(storage, key) {
  const current = storage.getItem(key);
  storage.setItem(key, current === "1" ? "0" : "1");
}

AppSettingsPage({
  state: {
    enableGyro: false,
    freqModeIndex: 1,
    sessionStatus: {},
    lastExportPath: "",
    transferProgress: {},
  },

  build(props) {
    this.loadState(props);

    const status = this.state.sessionStatus;
    const rate =
      status.observedHzX100 != null
        ? `${(Number(status.observedHzX100) / 100).toFixed(2)} Hz (measured)`
        : "n/a";

    const blocks = [
      View(
        { style: { margin: "1em", fontSize: "1.2rem", lineHeight: "1.6rem" } },
        [
          `State: ${status.state || "idle"}`,
          `Samples: ${status.sampleCount ?? 0}`,
          `Delivered rate: ${rate}`,
          `Gyro in session: ${status.hasGyro ? "yes" : "no"}`,
          `Last export: ${this.state.lastExportPath || "none"}`,
        ]
      ),
      Button({
        label: "Start logging on watch",
        color: "primary",
        style: { margin: "1em", width: "auto", fontSize: "1.3rem" },
        onClick: () => {
          props.settingsStorage.setItem(
            STORAGE_KEYS.CMD_LOGGING,
            LOGGING_CMD.START
          );
        },
      }),
      Button({
        label: "Stop logging on watch",
        color: "secondary",
        style: { margin: "1em", width: "auto", fontSize: "1.3rem" },
        onClick: () => {
          props.settingsStorage.setItem(
            STORAGE_KEYS.CMD_LOGGING,
            LOGGING_CMD.STOP
          );
        },
      }),
      TextInput({
        title: "Sample rate mode (0=LOW, 1=NORMAL, 2=HIGH)",
        bold: false,
        value: String(this.state.freqModeIndex),
        onChange: (value) => {
          const parsed = Number(value);
          if (parsed >= 0 && parsed <= 2) {
            this.state.freqModeIndex = parsed;
            props.settingsStorage.setItem(
              STORAGE_KEYS.PREF_FREQ_MODE,
              String(parsed)
            );
          }
        },
      }),
      View(
        { style: { margin: "0 1em", fontSize: "1rem", color: "#888" } },
        [
          `Requested: ${FREQ_MODE_LABELS[this.state.freqModeIndex]}. Docs do not publish Hz per mode; the watch records the delivered rate.`,
        ]
      ),
      ToggleSwitch({
        label: "Include gyroscope",
        checked: this.state.enableGyro,
        onChange: (checked) => {
          this.state.enableGyro = checked;
          props.settingsStorage.setItem(
            STORAGE_KEYS.PREF_ENABLE_GYRO,
            checked ? "true" : "false"
          );
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
        View(
          { style: { margin: "1em", fontSize: "1.1rem" } },
          [
            `Transfer: ${this.state.transferProgress.state}`,
            this.state.transferProgress.pct != null
              ? `Progress: ${this.state.transferProgress.pct}%`
              : "",
          ]
        )
      );
    }

    return View({}, blocks);
  },

  loadState(props) {
    this.state.enableGyro =
      props.settingsStorage.getItem(STORAGE_KEYS.PREF_ENABLE_GYRO) === "true";
    this.state.freqModeIndex = Number(
      props.settingsStorage.getItem(STORAGE_KEYS.PREF_FREQ_MODE) ?? 1
    );
    this.state.sessionStatus = readJson(
      props.settingsStorage.getItem(STORAGE_KEYS.SESSION_STATUS),
      {}
    );
    this.state.lastExportPath =
      props.settingsStorage.getItem(STORAGE_KEYS.LAST_EXPORT_PATH) || "";
    this.state.transferProgress = readJson(
      props.settingsStorage.getItem(STORAGE_KEYS.TRANSFER_PROGRESS),
      {}
    );
  },
});
