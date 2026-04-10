import type { SocketModeClient } from "@slack/socket-mode";
import { logger } from "../logger.ts";

function formatSocketDiagnosticPayload(payload: unknown): string {
  if (payload instanceof Error) return payload.message;
  if (typeof payload === "string") return payload;
  if (payload === null || payload === undefined) return "unknown";
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

/** Register diagnostic event listeners on a Socket Mode client.
 *  Logs connection lifecycle events, raw Slack events, and warns when
 *  no message events arrive (indicating a missing event subscription). */
export function registerSocketModeDiagnostics(client: SocketModeClient): void {
  client.on("connecting", () => {
    logger.info("[slack] Socket Mode connecting");
  });
  client.on("connected", () => {
    logger.info("[slack] Socket Mode connected");
  });
  client.on("reconnecting", () => {
    logger.warn("[slack] Socket Mode reconnecting");
  });
  client.on("disconnect", (payload) => {
    logger.warn(`[slack] Socket Mode disconnected: ${formatSocketDiagnosticPayload(payload)}`);
  });
  client.on("error", (payload) => {
    logger.error(`[slack] Socket Mode client error: ${formatSocketDiagnosticPayload(payload)}`);
  });
  client.on("unable_to_socket_mode_start", (payload) => {
    logger.error(`[slack] Socket Mode failed to start: ${formatSocketDiagnosticPayload(payload)}`);
  });

  // Log all incoming Slack events at the WebSocket level — helps diagnose
  // when Slack stops delivering events despite showing "connected".
  let lastImMessageAt: number | null = null;
  let hasReceivedNonMessageEvent = false;
  client.on(
    "slack_event",
    (args: { type?: string; body?: { event?: { type?: string; channel_type?: string } } }) => {
      const eventType = args.body?.event?.type ?? args.type ?? "unknown";
      logger.info(`[slack] Socket Mode received raw event: ${eventType}`);
      if (eventType === "message" && args.body?.event?.channel_type === "im") {
        lastImMessageAt = Date.now();
      } else if (eventType !== "message") {
        hasReceivedNonMessageEvent = true;
      }
    },
  );

  // Periodically check if we're receiving non-message events but no IM message events.
  // This detects the case where Socket Mode is connected but message.im subscription is missing.
  const MESSAGE_LIVENESS_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
  let hasLoggedNoImWarning = false;
  const livenessInterval = setInterval(() => {
    // Warn if other events arrive (proving the connection works) but no IM messages
    if (hasReceivedNonMessageEvent && lastImMessageAt === null && !hasLoggedNoImWarning) {
      hasLoggedNoImWarning = true;
      logger.warn(
        "[slack] No IM message events received since bot started, but other events are arriving. " +
          "Check that 'message.im' is listed under Event Subscriptions → Subscribe to bot events " +
          "in the Slack app settings at https://api.slack.com/apps",
      );
    }
  }, MESSAGE_LIVENESS_INTERVAL_MS);
  livenessInterval.unref();
}

/** Verify the bot token has required scopes and event subscriptions.
 *  Logs warnings for any missing pieces so misconfiguration is immediately visible. */
export async function verifyBotConfiguration(botToken: string): Promise<void> {
  try {
    const response = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/json",
      },
    });
    const data: {
      ok: boolean;
      error?: string;
      user_id?: string;
      bot_id?: string;
      team?: string;
    } = await response.json();
    if (!data.ok) {
      logger.error(`[slack] auth.test failed: ${data.error} — bot token may be invalid or revoked`);
      return;
    }
    logger.info(`[slack] Bot authenticated as ${data.user_id} in team ${data.team}`);

    // Slack returns installed scopes in the x-oauth-scopes response header
    const installedScopes = response.headers.get("x-oauth-scopes");
    if (installedScopes) {
      const scopeList = installedScopes.split(",").map((scope) => scope.trim());
      const requiredScopes = ["im:history", "chat:write", "users:read", "users:read.email"];
      const missingScopes = requiredScopes.filter((scope) => !scopeList.includes(scope));
      if (missingScopes.length > 0) {
        logger.error(
          `[slack] Bot token is missing required scopes: ${missingScopes.join(", ")}. ` +
            "Reinstall the app or update scopes at https://api.slack.com/apps",
        );
      } else {
        logger.info(`[slack] Bot scopes verified: ${installedScopes}`);
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn(`[slack] Could not verify bot configuration: ${errorMessage}`);
  }
}
