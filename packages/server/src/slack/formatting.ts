import type { NutritionItemWithMeal } from "../lib/ai-nutrition.ts";

interface SlackBlock {
  type: string;
  [key: string]: unknown;
}

interface SlackMessage {
  blocks: SlackBlock[];
  text: string;
}

function formatMacroLine(item: NutritionItemWithMeal): string {
  return `*${item.calories} cal* | P: ${item.proteinG}g | C: ${item.carbsG}g | F: ${item.fatG}g`;
}

/** Format parsed nutrition items into a Slack Block Kit message with confirm/cancel buttons */
export function formatConfirmationMessage(items: NutritionItemWithMeal[]): SlackMessage {
  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `Parsed ${items.length} item${items.length > 1 ? "s" : ""}`,
      },
    },
  ];

  for (const item of items) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${item.foodName}* (${item.meal})\n${item.foodDescription}\n${formatMacroLine(item)}`,
      },
    });
  }

  if (items.length > 1) {
    const totalCalories = items.reduce((sum, i) => sum + i.calories, 0);
    const totalProtein = items.reduce((sum, i) => sum + i.proteinG, 0);
    const totalCarbs = items.reduce((sum, i) => sum + i.carbsG, 0);
    const totalFat = items.reduce((sum, i) => sum + i.fatG, 0);

    blocks.push(
      { type: "divider" },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Total:* *${totalCalories} cal* | P: ${totalProtein.toFixed(1)}g | C: ${totalCarbs.toFixed(1)}g | F: ${totalFat.toFixed(1)}g`,
        },
      },
    );
  }

  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Confirm" },
        style: "primary",
        action_id: "confirm_food",
        value: JSON.stringify(items),
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Cancel" },
        style: "danger",
        action_id: "cancel_food",
      },
    ],
  });

  const fallbackText = items.map((i) => `${i.foodName}: ${i.calories} cal`).join(", ");

  return { blocks, text: fallbackText };
}

/** Format a success message after food entries are saved */
export function formatSavedMessage(items: NutritionItemWithMeal[]): SlackMessage {
  const blocks: SlackBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Logged ${items.length} item${items.length > 1 ? "s" : ""}:`,
      },
    },
  ];

  for (const item of items) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${item.foodName} — *${item.calories} cal*`,
      },
    });
  }

  const fallbackText = items.map((i) => `${i.foodName}: ${i.calories} cal`).join(", ");

  return { blocks, text: `Logged: ${fallbackText}` };
}
