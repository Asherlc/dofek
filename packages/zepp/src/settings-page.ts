import {
  type ConnectionState,
  deriveConnectionActions,
  parseConnectionState,
} from "./connection-state.ts";
import { getSessionAction, parseSessionState } from "./session-control.ts";
import { DEFAULT_DOFEK_SERVER_URL, FREQ_MODE_LABELS, STORAGE_KEYS as K } from "./storage-keys.ts";

declare function Image(props: Record<string, unknown>): unknown;
declare function Link(props: { source: string }, children: unknown[]): unknown;

interface SettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

type Style = Record<string, string | number>;
const INK = "#172b32";
const MUTED = "#536970";
const ACCENT = "#006b61";
const BORDER = "#e1e8e7";
const CONNECTION_LABELS: Record<ConnectionState, string> = {
  disconnected: "Not connected",
  pairing: "Waiting for approval",
  checking: "Checking connection",
  connected: "Connected",
  disconnecting: "Disconnecting",
  error: "Needs attention",
};

function text(value: string, style: Style = {}) {
  return View({ style: { lineHeight: "1.55", overflowWrap: "anywhere", ...style } }, [value]);
}

function card(title: string, description: string, children: unknown[]) {
  return View(
    {
      style: {
        background: "#ffffff",
        border: `1px solid ${BORDER}`,
        borderRadius: "20px",
        padding: "22px",
        marginBottom: "16px",
      },
    },
    [
      text(title, {
        fontSize: "18px",
        fontWeight: "700",
        letterSpacing: "-0.3px",
        marginBottom: "5px",
      }),
      text(description, { color: MUTED, fontSize: "14px", marginBottom: "18px" }),
      ...children,
    ],
  );
}

function action(label: string, onClick: () => void, primary = false) {
  return Button({
    label,
    onClick,
    style: {
      width: "100%",
      padding: "12px 16px",
      marginTop: "10px",
      borderRadius: "12px",
      boxShadow: "none",
      fontSize: "14px",
      fontWeight: "600",
      textTransform: "none",
      background: primary ? ACCENT : "#edf4f2",
      color: primary ? "#ffffff" : ACCENT,
    },
  });
}

function row(label: string, value: string) {
  return View(
    {
      style: {
        display: "flex",
        justifyContent: "space-between",
        gap: "16px",
        padding: "10px 0",
        borderBottom: `1px solid ${BORDER}`,
        fontSize: "14px",
      },
    },
    [
      text(label, { color: MUTED }),
      text(value, { textAlign: "right", fontWeight: "600", minWidth: "0" }),
    ],
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function status(storage: SettingsStorage, key: string): Record<string, unknown> {
  const raw = storage.getItem(key);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? Object.fromEntries(Object.entries(parsed)) : {};
  } catch (error) {
    return {
      state: "error",
      reason: `Stored settings data is invalid: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function statusRows(label: string, value: Record<string, unknown>) {
  return View({}, [
    row(label, String(value.state ?? "idle").replaceAll("_", " ")),
    ...(value.reason
      ? [
          text(String(value.reason), {
            color: value.state === "error" ? "#a63c32" : MUTED,
            background: value.state === "error" ? "#fff1ee" : "#f4f7f6",
            padding: "10px 12px",
            borderRadius: "10px",
            fontSize: "13px",
            marginTop: "8px",
          }),
        ]
      : []),
  ]);
}

function toggle(storage: SettingsStorage, key: string) {
  storage.setItem(key, storage.getItem(key) === "1" ? "0" : "1");
}

export function createSettingsPage(app: "zepp-main" | "zepp-workout") {
  const workout = app === "zepp-workout";
  const name = workout ? "Dofek Workout" : "Dofek";
  return {
    state: { password: "" },
    build({ settingsStorage: storage }: { settingsStorage: SettingsStorage }) {
      const connection = status(storage, K.DOFEK_CONNECTION_STATUS);
      const hasToken = Boolean(storage.getItem(K.DOFEK_API_TOKEN)?.trim());
      const storedState = parseConnectionState(connection.state);
      const connectionState =
        storedState === "connected" && !hasToken ? "disconnected" : storedState;
      const actions = deriveConnectionActions(connectionState, hasToken);
      const connected = connectionState === "connected";
      const pairing = connectionState === "pairing";
      const shortCode = storage.getItem(K.PAIRING_SHORT_CODE);
      const verificationUrl = storage.getItem(K.PAIRING_VERIFICATION_URL);
      const qrUrl = storage.getItem(K.PAIRING_QR_IMAGE_URL);
      const expiresAt = storage.getItem(K.PAIRING_EXPIRES_AT);
      const serverUrl = storage.getItem(K.DOFEK_SERVER_URL) ?? DEFAULT_DOFEK_SERVER_URL;
      const blocks: unknown[] = [
        View({ style: { padding: "10px 6px 26px" } }, [
          text("DOFEK  /  ZEPP", {
            color: ACCENT,
            fontSize: "11px",
            fontWeight: "700",
            letterSpacing: "2px",
            marginBottom: "12px",
          }),
          text(name, { fontSize: "32px", fontWeight: "750", letterSpacing: "-1px" }),
          text(workout ? "Your workouts, connected." : "Your health, connected.", {
            color: MUTED,
            fontSize: "16px",
            marginTop: "4px",
          }),
          View(
            {
              style: {
                display: "inline-block",
                marginTop: "16px",
                padding: "6px 11px",
                borderRadius: "20px",
                fontSize: "12px",
                fontWeight: "600",
                color: connected ? ACCENT : "#865b20",
                background: connected ? "#dff2ea" : "#fff0d7",
              },
            },
            [`${connected ? "●" : "○"} ${CONNECTION_LABELS[connectionState]}`],
          ),
        ]),
      ];

      const connectionContent: unknown[] = [];
      if (connection.reason) {
        connectionContent.push(
          text(String(connection.reason), {
            color: connectionState === "error" ? "#a63c32" : MUTED,
            fontSize: "14px",
            marginBottom: "14px",
          }),
        );
      }
      if (actions.showPairing || pairing) {
        if (shortCode && verificationUrl) {
          connectionContent.push(
            View(
              {
                style: {
                  textAlign: "center",
                  background: "#f5f9f7",
                  borderRadius: "14px",
                  padding: "20px 12px",
                  border: `1px solid ${BORDER}`,
                },
              },
              [
                ...(qrUrl
                  ? [
                      Image({
                        src: qrUrl,
                        alt: `${name} pairing QR code`,
                        width: 200,
                        height: 200,
                        style: {
                          display: "block",
                          margin: "0 auto 16px",
                          maxWidth: "100%",
                          height: "auto",
                          background: "white",
                          borderRadius: "8px",
                        },
                      }),
                    ]
                  : []),
                text("PAIRING CODE", {
                  color: MUTED,
                  fontSize: "10px",
                  letterSpacing: "1.8px",
                  fontWeight: "700",
                }),
                text(shortCode, {
                  fontSize: "28px",
                  fontWeight: "700",
                  letterSpacing: "4px",
                  marginTop: "6px",
                }),
                ...(expiresAt
                  ? [
                      text(`Expires ${new Date(expiresAt).toLocaleTimeString()}`, {
                        color: MUTED,
                        fontSize: "12px",
                        marginTop: "6px",
                      }),
                    ]
                  : []),
              ],
            ),
            View(
              {
                style: {
                  marginTop: "18px",
                  textAlign: "center",
                  color: ACCENT,
                  fontSize: "15px",
                  fontWeight: "600",
                },
              },
              [Link({ source: verificationUrl }, ["Open Dofek to finish pairing"])],
            ),
            text(
              "On another device? Scan the QR or enter this code in Dofek → Settings → Connections.",
              { color: MUTED, fontSize: "12px", textAlign: "center", marginTop: "12px" },
            ),
          );
        } else {
          connectionContent.push(
            text("Create a code, then open Dofek on this phone to approve the connection.", {
              color: MUTED,
              fontSize: "14px",
            }),
          );
        }
        if (actions.showPairing)
          connectionContent.push(
            action("Create pairing code", () => toggle(storage, K.CMD_START_PAIRING), true),
          );
      }
      if (connected) {
        connectionContent.push(
          text("Your connection has been verified by Dofek.", { color: MUTED, fontSize: "14px" }),
        );
      }
      if (actions.showCheck)
        connectionContent.push(
          action("Check connection", () => toggle(storage, K.CMD_CHECK_CONNECTION)),
        );
      if (pairing)
        connectionContent.push(action("Cancel pairing", () => toggle(storage, K.CMD_DISCONNECT)));
      blocks.push(
        card(
          connected ? "Connected to Dofek" : pairing ? "Finish pairing" : "Connect to Dofek",
          workout
            ? "Connect this Workout Extension to your Dofek account."
            : "Connect your watch to your Dofek account.",
          connectionContent,
        ),
      );

      if (actions.showLogin) {
        blocks.push(
          card(
            "Prefer to log in?",
            "Use your Dofek email and password instead of a pairing code.",
            [
              TextInput({
                label: "Email",
                bold: false,
                value: storage.getItem(K.DOFEK_EMAIL) ?? "",
                onChange: (value: string) => storage.setItem(K.DOFEK_EMAIL, value),
              }),
              TextInput({
                label: "Password",
                bold: false,
                placeholder: "Your Dofek password",
                onChange: (value: string) => {
                  this.state.password = value;
                },
              }),
              action("Log in", () => {
                storage.setItem(
                  K.CMD_LOGIN_PASSWORD,
                  JSON.stringify({
                    email: storage.getItem(K.DOFEK_EMAIL) ?? "",
                    password: this.state.password,
                    nonce: Date.now(),
                  }),
                );
                this.state.password = "";
              }),
            ],
          ),
        );
      }

      const session = status(storage, K.SESSION_STATUS);
      if (workout) {
        blocks.push(
          card("Set up on your watch", "Add Dofek Workout to each workout you want to capture.", [
            ...[
              "Open Workout and choose a workout.",
              "Open its settings, then Motion Extensions.",
              "Add Dofek Workout and open its page during your workout.",
            ].map((step, index) =>
              View(
                {
                  style: {
                    display: "flex",
                    gap: "12px",
                    alignItems: "flex-start",
                    marginBottom: "14px",
                  },
                },
                [
                  text(String(index + 1), {
                    color: ACCENT,
                    background: "#edf4f2",
                    borderRadius: "8px",
                    minWidth: "28px",
                    textAlign: "center",
                    fontSize: "13px",
                    fontWeight: "700",
                    padding: "3px 0",
                  }),
                  text(step, { fontSize: "14px", paddingTop: "3px" }),
                ],
              ),
            ),
            text(
              "Collection runs while the workout page is open. Saved samples wait for the phone when it is unavailable.",
              { color: MUTED, fontSize: "12px" },
            ),
          ]),
        );
      } else {
        const sessionAction = getSessionAction(parseSessionState(session.state));
        blocks.push(
          card("Watch recorder", "Record a motion session with the Dofek watch app open.", [
            row("Session", session.state === "recording" ? "Recording" : "Ready to record"),
            row("Samples captured", String(session.sampleCount ?? 0)),
            action(
              sessionAction.label,
              () => storage.setItem(K.CMD_LOGGING, sessionAction.command),
              true,
            ),
            action("Transfer saved session", () => toggle(storage, K.CMD_TRANSFER)),
            text(
              "Keep the watch app open until recording finishes. Gyroscope data is included automatically when supported.",
              { color: MUTED, fontSize: "12px", marginTop: "14px" },
            ),
          ]),
        );
      }

      const syncRows = [
        statusRows("Motion upload", status(storage, K.IMU_SYNC_STATUS)),
        statusRows("File transfer", status(storage, K.TRANSFER_PROGRESS)),
      ];
      if (!workout) {
        syncRows.unshift(
          statusRows("Health sync", status(storage, K.HEALTH_SYNC_STATUS)),
          statusRows("Background collection", status(storage, K.HEALTH_SERVICE_STATUS)),
        );
        const lastSync = storage.getItem(K.LAST_HEALTH_SYNC);
        syncRows.push(
          row(
            "Last health sync",
            lastSync ? new Date(Number(lastSync)).toLocaleString() : "Not synced yet",
          ),
        );
        if (actions.showSync)
          syncRows.push(action("Sync now", () => toggle(storage, K.CMD_SYNC_HEALTH), true));
      }
      blocks.push(card("Sync activity", "Delivery status from your watch and phone.", syncRows));

      const advanced: unknown[] = [];
      if (actions.showConnectionForm) {
        advanced.push(
          TextInput({
            label: "Server URL",
            bold: false,
            value: serverUrl,
            onChange: (value: string) => storage.setItem(K.DOFEK_SERVER_URL, value),
          }),
        );
      } else advanced.push(row("Server", serverUrl));
      advanced.push(
        text("Use the default server unless you host your own Dofek instance.", {
          color: MUTED,
          fontSize: "12px",
          marginTop: "8px",
        }),
      );
      if (!workout) {
        const mode = Number(storage.getItem(K.PREF_FREQ_MODE) ?? 1);
        advanced.push(
          TextInput({
            label: "Sample rate mode (0 low · 1 normal · 2 high)",
            bold: false,
            value: String(mode),
            onChange: (value: string) => {
              const parsed = Number(value);
              if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 2)
                storage.setItem(K.PREF_FREQ_MODE, String(parsed));
            },
          }),
          row("Requested mode", FREQ_MODE_LABELS[mode] ?? "Unknown"),
          row(
            "Measured sample rate",
            session.observedHzX100 != null
              ? `${(Number(session.observedHzX100) / 100).toFixed(2)} Hz`
              : "Not recorded yet",
          ),
          row("Gyroscope in session", session.hasGyro ? "Yes" : "No"),
          row("Last export", storage.getItem(K.LAST_EXPORT_PATH) ?? "None yet"),
        );
      }
      const transfer = status(storage, K.TRANSFER_PROGRESS);
      if (transfer.pct != null) advanced.push(row("Transfer progress", `${transfer.pct}%`));
      if (actions.showDisconnect && !pairing) {
        advanced.push(
          View(
            { style: { borderTop: `1px solid ${BORDER}`, marginTop: "20px", paddingTop: "12px" } },
            [
              text("Disconnect this app from your Dofek account.", {
                color: MUTED,
                fontSize: "12px",
              }),
              Button({
                label: "Disconnect",
                onClick: () => toggle(storage, K.CMD_DISCONNECT),
                style: {
                  width: "100%",
                  boxShadow: "none",
                  background: "#fff1ee",
                  color: "#a63c32",
                  borderRadius: "12px",
                  padding: "12px",
                  marginTop: "10px",
                  textTransform: "none",
                },
              }),
            ],
          ),
        );
      }
      blocks.push(card("Advanced", "Server configuration and device details.", advanced));
      blocks.push(
        text("DOFEK  ·  YOUR DATA, TOGETHER", {
          textAlign: "center",
          fontSize: "10px",
          letterSpacing: "1.5px",
          color: MUTED,
          padding: "10px 0 20px",
        }),
      );
      return View(
        {
          style: {
            background: "#f2f6f4",
            color: INK,
            minHeight: "100vh",
            fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
            boxSizing: "border-box",
            padding: "24px 16px",
          },
        },
        [View({ style: { maxWidth: "480px", margin: "0 auto" } }, blocks)],
      );
    },
  };
}
