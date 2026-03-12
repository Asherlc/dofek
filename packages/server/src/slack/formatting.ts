import type { NutritionItemWithMeal } from "../lib/ai-nutrition.ts";

interface SlackBlock {
  type: string;
  [key: string]: unknown;
}

interface SlackMessage {
  blocks: SlackBlock[];
  text: string;
}

type MicroKey = keyof NutritionItemWithMeal & string;

/** Micronutrient display definitions: field key, label, unit */
const MICRO_DISPLAY: Array<{ key: MicroKey; label: string; unit: string }> = [
  { key: "vitaminDMcg", label: "Vit D", unit: "mcg" },
  { key: "vitaminB12Mcg", label: "B12", unit: "mcg" },
  { key: "ironMg", label: "Iron", unit: "mg" },
  { key: "calciumMg", label: "Ca", unit: "mg" },
  { key: "magnesiumMg", label: "Mg", unit: "mg" },
  { key: "zincMg", label: "Zn", unit: "mg" },
  { key: "potassiumMg", label: "K", unit: "mg" },
  { key: "omega3Mg", label: "Ω3", unit: "mg" },
  { key: "vitaminAMcg", label: "Vit A", unit: "mcg" },
  { key: "vitaminCMg", label: "Vit C", unit: "mg" },
];

function formatMacroLine(item: NutritionItemWithMeal): string {
  return `*${item.calories} cal* | P: ${item.proteinG}g | C: ${item.carbsG}g | F: ${item.fatG}g`;
}

/** Format a condensed micronutrient line showing only non-zero values */
export function formatMicroLine(item: NutritionItemWithMeal): string {
  const parts: string[] = [];
  for (const { key, label, unit } of MICRO_DISPLAY) {
    const value = item[key] as number | undefined;
    if (value != null && value > 0) {
      const formatted = value < 10 ? value.toFixed(1) : Math.round(value).toString();
      parts.push(`${label}: ${formatted}${unit}`);
    }
  }
  return parts.join(" | ");
}

/** Sum a micronutrient field across items, returning undefined if all are undefined */
function sumMicro(items: NutritionItemWithMeal[], key: MicroKey): number | undefined {
  let total = 0;
  let hasValue = false;
  for (const item of items) {
    const value = item[key] as number | undefined;
    if (value != null) {
      total += value;
      hasValue = true;
    }
  }
  return hasValue ? total : undefined;
}

/** Build a NutritionItemWithMeal-like object with summed micros for total display */
function buildMicroTotals(items: NutritionItemWithMeal[]): NutritionItemWithMeal {
  const totals: Record<string, unknown> = {};
  for (const { key } of MICRO_DISPLAY) {
    totals[key] = sumMicro(items, key);
  }
  return totals as unknown as NutritionItemWithMeal;
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
    const microLine = formatMicroLine(item);
    const microSection = microLine ? `\n${microLine}` : "";
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${item.foodName}* (${item.meal})\n${item.foodDescription}\n${formatMacroLine(item)}${microSection}`,
      },
    });
  }

  if (items.length > 1) {
    const totalCalories = items.reduce((sum, i) => sum + i.calories, 0);
    const totalProtein = items.reduce((sum, i) => sum + i.proteinG, 0);
    const totalCarbs = items.reduce((sum, i) => sum + i.carbsG, 0);
    const totalFat = items.reduce((sum, i) => sum + i.fatG, 0);

    const microTotals = buildMicroTotals(items);
    const totalMicroLine = formatMicroLine(microTotals);
    const totalMicroSection = totalMicroLine ? `\n${totalMicroLine}` : "";

    blocks.push(
      { type: "divider" },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Total:* *${totalCalories} cal* | P: ${totalProtein.toFixed(1)}g | C: ${totalCarbs.toFixed(1)}g | F: ${totalFat.toFixed(1)}g${totalMicroSection}`,
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
