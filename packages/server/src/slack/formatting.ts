import {
  formatCalories,
  formatDateYmdInTimeZone,
  formatGrams,
  formatNutritionAmount,
  formatNutritionNumber,
  formatWeekdayTime,
} from "@dofek/format/format";
import type { NutritionItemWithMeal } from "../lib/ai-nutrition.ts";

interface SlackBlock {
  type: string;
  [key: string]: unknown;
}

interface SlackMessage {
  blocks: SlackBlock[];
  text: string;
}

export interface SavedFoodSummaryItem {
  foodName: string;
  calories: number;
}

type AvailableDailyCalorieProgress = {
  status?: "available";
  calorieGoal: number;
  caloriesConsumed: number;
};

export type DailyCalorieProgress =
  | AvailableDailyCalorieProgress
  | {
      status: "source_conflict";
      message: string;
      sourceLabels: string[];
    };

type MicroKey = keyof NutritionItemWithMeal & string;

/** Convert a Slack epoch timestamp to a readable local time string using the user's timezone. */
export function slackTimestampToLocalTime(slackTs: string, timezone: string): string {
  const epochSeconds = Number.parseFloat(slackTs);
  return formatWeekdayTime(epochSeconds * 1000, { timeZone: timezone });
}

/** Convert a Slack epoch timestamp to YYYY-MM-DD date string in the user's timezone. */
export function slackTimestampToDateString(slackTs: string, timezone: string): string {
  const epochSeconds = Number.parseFloat(slackTs);
  return formatDateYmdInTimeZone(epochSeconds * 1000, timezone);
}

/** Object containing only micronutrient values, used for summing totals */
type MicroTotals = Partial<Record<MicroKey, number | undefined>>;

/** Micronutrient display definitions: field key, label, unit */
const MICRO_DISPLAY: Array<{ key: MicroKey; label: string; unit: string }> = [
  // Fat breakdown
  { key: "polyunsaturatedFatG", label: "Poly Fat", unit: "g" },
  { key: "monounsaturatedFatG", label: "Mono Fat", unit: "g" },
  { key: "transFatG", label: "Trans Fat", unit: "g" },
  { key: "cholesterolMg", label: "Chol", unit: "mg" },
  // Minerals
  { key: "potassiumMg", label: "K", unit: "mg" },
  { key: "calciumMg", label: "Ca", unit: "mg" },
  { key: "ironMg", label: "Iron", unit: "mg" },
  { key: "magnesiumMg", label: "Mg", unit: "mg" },
  { key: "zincMg", label: "Zn", unit: "mg" },
  { key: "seleniumMcg", label: "Se", unit: "mcg" },
  { key: "copperMg", label: "Cu", unit: "mg" },
  { key: "manganeseMg", label: "Mn", unit: "mg" },
  { key: "chromiumMcg", label: "Cr", unit: "mcg" },
  { key: "iodineMcg", label: "I", unit: "mcg" },
  // Vitamins
  { key: "vitaminAMcg", label: "Vit A", unit: "mcg" },
  { key: "vitaminCMg", label: "Vit C", unit: "mg" },
  { key: "vitaminDMcg", label: "Vit D", unit: "mcg" },
  { key: "vitaminEMg", label: "Vit E", unit: "mg" },
  { key: "vitaminKMcg", label: "Vit K", unit: "mcg" },
  { key: "vitaminB1Mg", label: "B1", unit: "mg" },
  { key: "vitaminB2Mg", label: "B2", unit: "mg" },
  { key: "vitaminB3Mg", label: "B3", unit: "mg" },
  { key: "vitaminB5Mg", label: "B5", unit: "mg" },
  { key: "vitaminB6Mg", label: "B6", unit: "mg" },
  { key: "vitaminB7Mcg", label: "B7", unit: "mcg" },
  { key: "vitaminB9Mcg", label: "B9", unit: "mcg" },
  { key: "vitaminB12Mcg", label: "B12", unit: "mcg" },
  // Fatty acids
  { key: "omega3Mg", label: "Ω3", unit: "mg" },
  { key: "omega6Mg", label: "Ω6", unit: "mg" },
];

function formatMacroLine(item: NutritionItemWithMeal): string {
  return `*${formatCalories(item.calories)}* | P: ${formatGrams(item.proteinG)} | C: ${formatGrams(item.carbsG)} | F: ${formatGrams(item.fatG)}`;
}

function formatCalorieProgressBar(progress: AvailableDailyCalorieProgress): string {
  const rawPercentage =
    progress.calorieGoal > 0 ? (progress.caloriesConsumed / progress.calorieGoal) * 100 : 0;
  const percentage =
    rawPercentage >= 100 ? Math.round(rawPercentage) : Math.max(Math.floor(rawPercentage), 0);
  const filledSegments = Math.min(Math.max(Math.floor(rawPercentage / 10), 0), 10);
  const emptySegments = 10 - filledSegments;
  return `[${"█".repeat(filledSegments)}${"░".repeat(emptySegments)}] ${formatNutritionNumber(percentage)}%`;
}

function formatDailyCalorieProgress(progress: DailyCalorieProgress): string {
  if (progress.status === "source_conflict") {
    return `${progress.message}\nSources: ${progress.sourceLabels.join(", ")}`;
  }
  const calorieLine = `Calories: ${formatCalories(progress.caloriesConsumed)} / ${formatCalories(progress.calorieGoal)}`;
  const progressBar = formatCalorieProgressBar(progress);
  return `${calorieLine}\n${progressBar}\n${formatDailyCalorieStatus(progress)}`;
}

function formatDailyCalorieStatus(progress: AvailableDailyCalorieProgress): string {
  const caloriesRemaining = Math.round(progress.calorieGoal - progress.caloriesConsumed);
  if (caloriesRemaining > 0) {
    return `${formatCalories(caloriesRemaining)} remaining today`;
  }
  if (caloriesRemaining < 0) {
    return `${formatCalories(Math.abs(caloriesRemaining))} over goal today`;
  }
  return "Calorie goal reached today";
}

/** Format a condensed micronutrient line showing only non-zero values */
export function formatMicroLine(item: NutritionItemWithMeal | MicroTotals): string {
  const parts: string[] = [];
  for (const { key, label, unit } of MICRO_DISPLAY) {
    const rawValue = item[key];
    if (typeof rawValue !== "number") continue;
    if (rawValue > 0) {
      parts.push(`${label}: ${formatNutritionAmount(rawValue, unit)}`);
    }
  }
  return parts.join(" | ");
}

/** Sum a micronutrient field across items, returning undefined if all are undefined */
function sumMicro(items: NutritionItemWithMeal[], key: MicroKey): number | undefined {
  let total = 0;
  let hasValue = false;
  for (const item of items) {
    const rawValue = item[key];
    if (typeof rawValue === "number") {
      total += rawValue;
      hasValue = true;
    }
  }
  return hasValue ? total : undefined;
}

/** Build an object with summed micros for total display */
function buildMicroTotals(items: NutritionItemWithMeal[]): MicroTotals {
  const totals: Partial<Record<MicroKey, number | undefined>> = {};
  for (const { key } of MICRO_DISPLAY) {
    totals[key] = sumMicro(items, key);
  }
  return totals;
}

/** Format parsed nutrition items into a Slack Block Kit message with confirm/cancel buttons.
 *  The buttonValue is stored in the confirm button (e.g., comma-separated food entry IDs). */
export function formatConfirmationMessage(
  items: NutritionItemWithMeal[],
  buttonValue?: string,
): SlackMessage {
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
          text: `*Total:* *${formatCalories(totalCalories)}* | P: ${formatGrams(totalProtein)} | C: ${formatGrams(totalCarbs)} | F: ${formatGrams(totalFat)}${totalMicroSection}`,
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
        value: buttonValue ?? JSON.stringify(items),
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Cancel" },
        style: "danger",
        action_id: "cancel_food",
      },
    ],
  });

  const fallbackText = items
    .map((itemSummary) => `${itemSummary.foodName}: ${formatCalories(itemSummary.calories)}`)
    .join(", ");

  return { blocks, text: fallbackText };
}

/** Format a success message after food entries are saved */
export function formatSavedMessage(
  items: SavedFoodSummaryItem[],
  dailyCalorieProgress?: DailyCalorieProgress | null,
): SlackMessage {
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
        text: `${item.foodName} — *${formatCalories(item.calories)}*`,
      },
    });
  }

  const dailyCalorieProgressText = dailyCalorieProgress
    ? formatDailyCalorieProgress(dailyCalorieProgress)
    : null;
  const dailyCalorieStatusText = dailyCalorieProgress
    ? dailyCalorieProgress.status === "source_conflict"
      ? dailyCalorieProgress.message
      : formatDailyCalorieStatus(dailyCalorieProgress)
    : null;
  if (dailyCalorieProgressText) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: dailyCalorieProgressText,
      },
    });
  }

  const fallbackText = items
    .map((itemSummary) => `${itemSummary.foodName}: ${formatCalories(itemSummary.calories)}`)
    .join(", ");

  return {
    blocks,
    text: dailyCalorieStatusText
      ? `Logged: ${fallbackText}. ${dailyCalorieStatusText}`
      : `Logged: ${fallbackText}`,
  };
}
