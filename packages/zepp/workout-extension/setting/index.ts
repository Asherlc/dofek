import { DEFAULT_DOFEK_SERVER_URL, STORAGE_KEYS } from "../../src/storage-keys.ts";

const state = {
  serverUrl: DEFAULT_DOFEK_SERVER_URL,
  email: "",
  password: "",
  connectionStatus: "not connected",
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
    const rawStatus = props.settingsStorage.getItem(STORAGE_KEYS.DOFEK_CONNECTION_STATUS);
    if (rawStatus) {
      try {
        const parsed: unknown = JSON.parse(rawStatus);
        if (typeof parsed === "object" && parsed !== null && "state" in parsed) {
          this.state.connectionStatus = String(parsed.state);
        }
      } catch {
        this.state.connectionStatus = "invalid saved status";
      }
    }

    return View({ style: { padding: "1em" } }, [
      View({ style: { fontSize: "1.4rem", fontWeight: "bold", marginBottom: "1em" } }, [
        "Dofek Workout Sync",
      ]),
      TextInput({
        title: "Dofek Server URL",
        value: this.state.serverUrl,
        onChange: (value: string) => {
          this.state.serverUrl = value;
          props.settingsStorage.setItem(STORAGE_KEYS.DOFEK_SERVER_URL, value);
        },
      }),
      TextInput({
        title: "Dofek Email",
        value: this.state.email,
        onChange: (value: string) => {
          this.state.email = value;
          props.settingsStorage.setItem(STORAGE_KEYS.DOFEK_EMAIL, value);
        },
      }),
      TextInput({
        title: "Dofek Password",
        placeholder: "Enter your Dofek password",
        onChange: (value: string) => {
          this.state.password = value;
        },
      }),
      Button({
        label: "Connect Dofek",
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
      View({ style: { marginTop: "1em" } }, [`Connection: ${this.state.connectionStatus}`]),
      View({ style: { marginTop: "1em", color: "#888" } }, [
        "Enable Dofek Workout inside the watch Workout app. Live samples are buffered and retried when the phone is unavailable.",
      ]),
    ]);
  },
});
