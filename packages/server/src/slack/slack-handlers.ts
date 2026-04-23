import type { App as AppType, SayFn } from "@slack/bolt";
import { analyzeNutritionItems, refineNutritionItems } from "../lib/ai-nutrition.ts";
import { queryCache } from "../lib/cache.ts";
import { logger } from "../logger.ts";
import { createSlackDedupeStore, type SlackDedupeStore } from "./dedupe-store.ts";
import {
  extractLatestConfirmFromThread,
  type FoodEntryRepository,
  slackTimestampToDateString,
  slackTimestampToLocalTime,
} from "./food-entry-repository.ts";
import { formatConfirmationMessage, formatSavedMessage } from "./formatting.ts";

type SayFunction = SayFn;
const DEDUPE_TTL_MS = 10 * 60 * 1000;

interface ParsedMessageArgs {
  say: SayFunction;
  getUserInfo: (slackUserId: string) => Promise<{
    user?: { tz?: string; real_name?: string; profile?: { email?: string } };
  }>;
  getThreadReplies: (
    channel: string,
    ts: string,
  ) => Promise<{
    messages?: Array<{ bot_id?: string; blocks?: unknown[]; ts?: string }>;
  }>;
  postMessage: (message: { channel: string; text: string; thread_ts?: string }) => Promise<{
    ts?: string;
  }>;
  updateMessage: (message: {
    channel: string;
    ts: string;
    text?: string;
    blocks?: unknown[];
    [key: string]: unknown;
  }) => Promise<unknown>;
  msgText: string;
  msgUser: string;
  msgTs: string;
  msgChannel: string;
  msgThreadTs?: string;
}

function splitEntryIds(rawValue: string): string[] {
  return rawValue
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

function extractEventId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  if (!("event_id" in body)) return null;
  const eventId = body.event_id;
  return typeof eventId === "string" && eventId.length > 0 ? eventId : null;
}

function buildActionDedupeKey(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  if (!("type" in body) || body.type !== "block_actions") return null;

  const teamId =
    "team" in body &&
    body.team &&
    typeof body.team === "object" &&
    "id" in body.team &&
    typeof body.team.id === "string"
      ? body.team.id
      : null;

  const userId =
    "user" in body &&
    body.user &&
    typeof body.user === "object" &&
    "id" in body.user &&
    typeof body.user.id === "string"
      ? body.user.id
      : null;

  const channelId =
    "channel" in body &&
    body.channel &&
    typeof body.channel === "object" &&
    "id" in body.channel &&
    typeof body.channel.id === "string"
      ? body.channel.id
      : null;

  const messageTs =
    "message" in body &&
    body.message &&
    typeof body.message === "object" &&
    "ts" in body.message &&
    typeof body.message.ts === "string"
      ? body.message.ts
      : null;

  const actionId =
    "actions" in body &&
    Array.isArray(body.actions) &&
    body.actions[0] &&
    typeof body.actions[0] === "object" &&
    "action_id" in body.actions[0] &&
    typeof body.actions[0].action_id === "string"
      ? body.actions[0].action_id
      : null;

  if (!teamId || !userId || !channelId || !messageTs || !actionId) return null;
  return `${teamId}:${channelId}:${messageTs}:${actionId}:${userId}`;
}

async function skipDuplicateEvent(dedupeStore: SlackDedupeStore, body: unknown): Promise<boolean> {
  const eventId = extractEventId(body);
  if (!eventId) return false;

  const claimed = await dedupeStore.claim(`event:${eventId}`, DEDUPE_TTL_MS);
  if (claimed) return false;

  logger.warn(`[slack] Duplicate event delivery skipped: event_id=${eventId}`);
  return true;
}

async function skipDuplicateAction(
  dedupeStore: SlackDedupeStore,
  actionName: string,
  body: unknown,
): Promise<boolean> {
  const actionKey = buildActionDedupeKey(body);
  if (!actionKey) return false;

  const claimed = await dedupeStore.claim(`action:${actionName}:${actionKey}`, DEDUPE_TTL_MS);
  if (claimed) return false;

  logger.warn(`[slack] Duplicate action delivery skipped: action=${actionName} key=${actionKey}`);
  return true;
}

async function resolveConfirmEntryIds(
  repository: FoodEntryRepository,
  actionValue: string,
  channelId: string | undefined,
  messageTs: string | undefined,
): Promise<string[]> {
  const actionEntryIds = splitEntryIds(actionValue);
  const messageIndexedEntryIds =
    channelId && messageTs ? await repository.findPendingIdsByMessage(channelId, messageTs) : [];
  return messageIndexedEntryIds.length > 0 ? messageIndexedEntryIds : actionEntryIds;
}

async function updateConfirmationStateMessage(
  updateMessage: (channelId: string, messageTs: string, text: string) => Promise<unknown>,
  channelId: string | undefined,
  messageTs: string | undefined,
  text: string,
): Promise<void> {
  if (!channelId || !messageTs) return;
  await updateMessage(channelId, messageTs, text);
}

async function invalidateConfirmedFoodCaches(
  repository: FoodEntryRepository,
  confirmation: {
    userId: string | null;
  },
  confirmedEntryIds: string[],
): Promise<void> {
  const entryUserId =
    confirmation.userId ?? (await repository.lookupUserIdForEntries(confirmedEntryIds));
  if (!entryUserId) return;
  await queryCache.invalidateByPrefix(`${entryUserId}:food.`);
  await queryCache.invalidateByPrefix(`${entryUserId}:nutrition.`);
}

async function handleParsedMessage(
  repository: FoodEntryRepository,
  args: ParsedMessageArgs,
): Promise<void> {
  const {
    say,
    getUserInfo,
    getThreadReplies,
    postMessage,
    updateMessage,
    msgText,
    msgUser,
    msgTs,
    msgChannel,
    msgThreadTs,
  } = args;
  try {
    const { userId, timezone: userTimezone } = await repository.lookupOrCreateUserId(msgUser, {
      users: {
        info: ({ user }) => getUserInfo(user),
      },
    });

    const date = slackTimestampToDateString(msgTs, userTimezone);

    // Thread reply — look for previous items to refine
    if (msgThreadTs && msgThreadTs !== msgTs) {
      logger.info(`[slack] Thread reply from ${msgUser}: "${msgText}"`);

      try {
        const thread = await getThreadReplies(msgChannel, msgThreadTs);
        const previousConfirmContext = extractLatestConfirmFromThread(thread.messages ?? []);
        const previousEntryIds = previousConfirmContext?.entryIds ?? null;

        if (previousEntryIds) {
          const previousItems = await repository.loadForRefinement(previousEntryIds);

          if (previousItems.length > 0) {
            logger.info(`[slack] Refining ${previousItems.length} items with: "${msgText}"`);

            const thinkingMsg = await postMessage({
              channel: msgChannel,
              thread_ts: msgThreadTs,
              text: "Updating your entries...",
            });

            const localTime = slackTimestampToLocalTime(msgTs, userTimezone);
            const result = await refineNutritionItems(previousItems, msgText, localTime);

            await repository.deleteUnconfirmed(previousEntryIds);
            const confirmationMessageTs =
              thinkingMsg.ts ?? `fallback-refine-${msgThreadTs}-${Date.now()}`;
            const newEntryIds = await repository.saveUnconfirmed(userId, date, result.items, {
              channelId: msgChannel,
              confirmationMessageTs,
              threadTs: msgThreadTs,
              sourceMessageTs: msgTs,
              slackUserId: msgUser,
            });

            const entryIdsValue = newEntryIds.join(",");
            const confirmation = formatConfirmationMessage(result.items, entryIdsValue);

            if (thinkingMsg.ts) {
              await updateMessage({
                channel: msgChannel,
                ts: thinkingMsg.ts,
                ...confirmation,
              });
            } else {
              await say({ ...confirmation, thread_ts: msgThreadTs });
            }

            // Retire the previous confirmation message so users don't click stale
            // buttons that reference now-deleted unconfirmed entry IDs.
            if (previousConfirmContext?.messageTs) {
              try {
                await updateMessage({
                  channel: msgChannel,
                  ts: previousConfirmContext.messageTs,
                  text: "Superseded by a newer edit below.",
                  blocks: [],
                });
              } catch (updateError) {
                logger.warn(
                  `[slack] Failed to retire prior confirmation: ${updateError instanceof Error ? updateError.message : String(updateError)}`,
                );
              }
            }
            return;
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`[slack] Refinement failed: ${errorMessage}`);
        await say({
          text: `Sorry, I couldn't refine that.\n\`${errorMessage}\``,
          thread_ts: msgThreadTs,
        });
        return;
      }
    }

    // Top-level message — fresh analysis (reply in thread so user can refine)
    logger.info(`[slack] Parsing food from ${msgUser}: "${msgText}"`);

    const thinkingMsg = await postMessage({
      channel: msgChannel,
      thread_ts: msgTs,
      text: "Analyzing what you ate...",
    });

    try {
      const localTime = slackTimestampToLocalTime(msgTs, userTimezone);
      const result = await analyzeNutritionItems(msgText, localTime);
      const confirmationMessageTs = thinkingMsg.ts ?? `fallback-parse-${msgTs}-${Date.now()}`;
      const entryIds = await repository.saveUnconfirmed(userId, date, result.items, {
        channelId: msgChannel,
        confirmationMessageTs,
        threadTs: msgTs,
        sourceMessageTs: msgTs,
        slackUserId: msgUser,
      });
      const entryIdsValue = entryIds.join(",");
      const confirmation = formatConfirmationMessage(result.items, entryIdsValue);

      if (thinkingMsg.ts) {
        await updateMessage({
          channel: msgChannel,
          ts: thinkingMsg.ts,
          ...confirmation,
        });
      } else {
        await say({ ...confirmation, thread_ts: msgTs });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`[slack] AI analysis failed: ${errorMessage}`);

      const errorText = `Sorry, I couldn't parse that. Try describing what you ate more specifically.\n\`${errorMessage}\``;
      if (thinkingMsg.ts) {
        await updateMessage({
          channel: msgChannel,
          ts: thinkingMsg.ts,
          text: errorText,
          blocks: [],
        });
      } else {
        await say({ text: errorText, thread_ts: msgTs });
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`[slack] Message handler failed: ${errorMessage}`);
    try {
      await say({
        text: `Sorry, something went wrong.\n\`${errorMessage}\``,
        thread_ts: msgThreadTs ?? msgTs,
      });
    } catch (sayError) {
      logger.error(
        `[slack] Failed to send error reply: ${sayError instanceof Error ? sayError.message : String(sayError)}`,
      );
    }
  }
}

/** Register all Slack Bolt event/action handlers on the given app.
 *  Delegates database operations to the provided repository. */
export function registerHandlers(
  app: AppType,
  repository: FoodEntryRepository,
  dedupeStore: SlackDedupeStore = createSlackDedupeStore(),
): void {
  // Log all incoming events for diagnostics
  app.use(async (args) => {
    if ("event" in args && args.event && typeof args.event === "object" && "type" in args.event) {
      logger.info(`[slack] Received event type=${String(args.event.type)}`);
    } else {
      logger.info("[slack] Received non-event payload (action/shortcut/command)");
    }
    await args.next();
  });

  // Handle direct messages (both top-level and thread replies)
  app.message(async ({ message, say, client, body }) => {
    if (await skipDuplicateEvent(dedupeStore, body)) return;

    logger.info(
      `[slack] Message handler invoked: type=${message.type ?? "unknown"}, subtype=${"subtype" in message ? message.subtype : "none"}, has_text=${"text" in message && !!message.text}, has_user=${"user" in message && !!message.user}, has_bot_id=${"bot_id" in message && !!message.bot_id}`,
    );
    if (!("text" in message) || !message.text) return;
    if ("subtype" in message && message.subtype) return;
    if ("bot_id" in message && message.bot_id) return;
    if (!("user" in message) || !message.user) return;
    if (!("ts" in message) || !message.ts) return;
    if (!("channel" in message) || !message.channel) return;
    const msgText = message.text;
    const msgUser = message.user;
    const msgTs = message.ts;
    const msgChannel = message.channel;
    const msgThreadTs = "thread_ts" in message ? message.thread_ts : undefined;

    const updateMessage =
      typeof client.chat?.update === "function"
        ? (message: {
            channel: string;
            ts: string;
            text?: string;
            blocks?: unknown[];
            [key: string]: unknown;
          }) =>
            client.chat.update({
              ...message,
              attachments: [],
            })
        : async () => ({});

    const postMessage =
      typeof client.chat?.postMessage === "function"
        ? (message: { channel: string; text: string; thread_ts?: string }) =>
            client.chat.postMessage(message)
        : async () => ({ ts: undefined });

    await handleParsedMessage(repository, {
      say,
      getUserInfo: (slackUserId) => client.users.info({ user: slackUserId }),
      getThreadReplies: (channel, ts) => client.conversations.replies({ channel, ts }),
      postMessage,
      updateMessage,
      msgText,
      msgUser,
      msgTs,
      msgChannel,
      msgThreadTs,
    });
  });

  // Handle app mentions in channels (<@BOT> ...)
  app.event("app_mention", async ({ event, say, client, body }) => {
    if (await skipDuplicateEvent(dedupeStore, body)) return;

    if (!event.text || !event.user || !event.ts || !event.channel) return;

    const mentionPrefix = /^<@[^>]+>\s*/;
    const msgText = event.text.replace(mentionPrefix, "").trim();
    if (!msgText) return;

    logger.info(`[slack] App mention from ${event.user}: "${msgText}"`);

    const updateMessage =
      typeof client.chat?.update === "function"
        ? (message: {
            channel: string;
            ts: string;
            text?: string;
            blocks?: unknown[];
            [key: string]: unknown;
          }) =>
            client.chat.update({
              ...message,
              attachments: [],
            })
        : async () => ({});

    const postMessage =
      typeof client.chat?.postMessage === "function"
        ? (message: { channel: string; text: string; thread_ts?: string }) =>
            client.chat.postMessage(message)
        : async () => ({ ts: undefined });

    await handleParsedMessage(repository, {
      say,
      getUserInfo: (slackUserId) => client.users.info({ user: slackUserId }),
      getThreadReplies: (channel, ts) => client.conversations.replies({ channel, ts }),
      postMessage,
      updateMessage,
      msgText,
      msgUser: event.user,
      msgTs: event.ts,
      msgChannel: event.channel,
      msgThreadTs: event.thread_ts,
    });
  });

  // Handle "Confirm" button click
  app.action("confirm_food", async ({ ack, body, client }) => {
    await ack();

    if (body.type !== "block_actions" || !body.actions[0]) return;

    const action = body.actions[0];
    if (!("value" in action) || !action.value) return;

    if (await skipDuplicateAction(dedupeStore, "confirm_food", body)) return;

    const channelId = body.channel?.id;
    const messageTs = body.message?.ts;
    const updateMessage = (updateChannelId: string, updateMessageTs: string, updateText: string) =>
      client.chat.update({
        channel: updateChannelId,
        ts: updateMessageTs,
        text: updateText,
        blocks: [],
      });
    const entryIds = await resolveConfirmEntryIds(repository, action.value, channelId, messageTs);
    logger.info(
      `[slack] confirm_food action: entryIds=${JSON.stringify(entryIds)}, buttonValue=${action.value.substring(0, 100)}`,
    );

    if (entryIds.length === 0) {
      logger.warn("[slack] confirm_food: no entry IDs available for confirmation");
      await updateConfirmationStateMessage(
        updateMessage,
        channelId,
        messageTs,
        "This confirmation is invalid or expired. Please confirm the latest parsed message.",
      );
      return;
    }

    try {
      const confirmation = await repository.confirm(entryIds);
      const confirmedCount = confirmation.confirmedCount;
      logger.info(`[slack] confirmFoodEntries updated ${confirmedCount} rows`);

      const confirmedEntryIds = confirmation.confirmedEntryIds;
      const rows = await repository.loadConfirmedSummary(
        confirmedEntryIds.length > 0 ? confirmedEntryIds : entryIds,
      );

      if (rows.length === 0) {
        logger.warn(`[slack] confirm_food: no entries found for IDs ${entryIds.join(",")}`);
        await updateConfirmationStateMessage(
          updateMessage,
          channelId,
          messageTs,
          "This confirmation has expired. Please confirm the latest parsed message.",
        );
        return;
      }

      const items = rows.map((row) => ({
        foodName: row.food_name,
        calories: row.calories ?? 0,
      }));

      const savedMessage = formatSavedMessage(items);

      if (body.channel?.id && body.message?.ts) {
        await client.chat.update({
          channel: body.channel.id,
          ts: body.message.ts,
          ...savedMessage,
        });
      }

      // Invalidate cached food/nutrition queries so the UI reflects the new entries.
      await invalidateConfirmedFoodCaches(repository, confirmation, confirmedEntryIds);

      logger.info(`[slack] Confirmed ${confirmedCount} food entries (${rows.length} total)`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`[slack] Failed to confirm food entries: ${errorMessage}`);

      if (body.channel?.id && body.message?.ts) {
        await client.chat.update({
          channel: body.channel.id,
          ts: body.message.ts,
          text: `Failed to save: ${errorMessage}`,
          blocks: [],
        });
      }
    }
  });

  // Publish Home Tab when user opens the app
  app.event("app_home_opened", async ({ event, client }) => {
    try {
      await client.views.publish({
        user_id: event.user,
        view: {
          type: "home",
          blocks: [
            {
              type: "header",
              text: { type: "plain_text", text: "Dofek — Nutrition Tracker" },
            },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: "Track what you eat by sending me a message. I'll use AI to estimate the nutrition and let you confirm before saving.",
              },
            },
            { type: "divider" },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: "*How it works:*\n\n1. Send me a DM describing what you ate\n2. I'll parse it into individual items with calorie and macro estimates\n3. Review and hit *Confirm* to save, or *Cancel* to discard",
              },
            },
            { type: "divider" },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: '*Examples:*\n\n• _"Two eggs, toast with butter, and a coffee with milk"_\n• _"Chicken salad with avocado for lunch"_\n• _"A slice of pepperoni pizza and a coke"_',
              },
            },
            {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: "Tip: Be specific about portions and preparation for more accurate estimates.",
                },
              ],
            },
          ],
        },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`[slack] Failed to publish Home Tab: ${errorMessage}`);
    }
  });

  // Handle "Cancel" button click — delete unconfirmed entries
  app.action("cancel_food", async ({ ack, body, client }) => {
    await ack();

    if (body.type !== "block_actions") return;
    if (await skipDuplicateAction(dedupeStore, "cancel_food", body)) return;

    if (body.message?.blocks) {
      const blocks: Array<{
        type?: string;
        elements?: Array<{ action_id?: string; value?: string }>;
      }> = body.message.blocks;
      for (const rawBlock of blocks) {
        if (rawBlock.type !== "actions" || !rawBlock.elements) continue;
        for (const element of rawBlock.elements) {
          if (element.action_id === "confirm_food" && element.value) {
            const entryIds = splitEntryIds(element.value);
            await repository.deleteUnconfirmed(entryIds);
            break;
          }
        }
      }
    }

    if (body.channel?.id && body.message?.ts) {
      await client.chat.update({
        channel: body.channel.id,
        ts: body.message.ts,
        text: "Cancelled.",
        blocks: [],
      });
    }
  });
}
