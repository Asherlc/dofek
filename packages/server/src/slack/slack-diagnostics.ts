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
  let lastMessageEventAt: number | null = null;
  let hasLoggedNoMessageWarning = false;
  client.on("slack_event", (args: { type?: string; body?: { event?: { type?: string } } }) => {
    const eventType = args.body?.event?.type ?? args.type ?? "unknown";
    logger.info(`[slack] Socket Mode received raw event: ${eventType}`);
    if (eventType === "message") {
      lastMessageEventAt = Date.now();
      hasLoggedNoMessageWarning = false;
    }
  });

  // Periodically check if we're receiving non-message events but no message events.
  // This detects the case where Socket Mode is connected but message.im subscription is missing.
  const MESSAGE_LIVENESS_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
  const livenessInterval = setInterval(() => {
    if (lastMessageEventAt === null && !hasLoggedNoMessageWarning) {
      hasLoggedNoMessageWarning = true;
      logger.warn(
        "[slack] No message events received since bot started. " +
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
    const data: { ok: boolean; error?: string; user_id?: string; team?: string } =
      await response.json();
    if (!data.ok) {
      logger.error(`[slack] auth.test failed: ${data.error} — bot token may be invalid or revoked`);
      return;
    }
    logger.info(`[slack] Bot authenticated as ${data.user_id} in team ${data.team}`);

    const botInfoResponse = await fetch("https://slack.com/api/bots.info", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/json",
      },
    });
    const botInfo: {
      ok: boolean;
      bot?: { app_id?: string };
      response_metadata?: { scopes?: string[] };
    } = await botInfoResponse.json();

    // Log the scopes from the response headers (Slack returns x-oauth-scopes)
    const installedScopes = botInfoResponse.headers.get("x-oauth-scopes");
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

    if (botInfo.ok && botInfo.bot?.app_id) {
      logger.info(`[slack] Bot app_id: ${botInfo.bot.app_id}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn(`[slack] Could not verify bot configuration: ${errorMessage}`);
  }
}
