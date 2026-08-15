import { formatNutritionAmount } from "@dofek/format/format";
import { trpc } from "../lib/trpc.ts";
import { QueryStatePanel } from "./QueryStatePanel.tsx";

interface Supplement {
  name: string;
  amount?: number;
  unit?: string;
  form?: string;
  description?: string;
  meal?: "breakfast" | "lunch" | "dinner" | "snack" | "other";
  calories?: number | null;
  proteinG?: number | null;
  carbsG?: number | null;
  fatG?: number | null;
  saturatedFatG?: number | null;
  polyunsaturatedFatG?: number | null;
  monounsaturatedFatG?: number | null;
  transFatG?: number | null;
  cholesterolMg?: number | null;
  sodiumMg?: number | null;
  potassiumMg?: number | null;
  fiberG?: number | null;
  sugarG?: number | null;
  vitaminAMcg?: number | null;
  vitaminCMg?: number | null;
  vitaminDMcg?: number | null;
  vitaminEMg?: number | null;
  vitaminKMcg?: number | null;
  vitaminB1Mg?: number | null;
  vitaminB2Mg?: number | null;
  vitaminB3Mg?: number | null;
  vitaminB5Mg?: number | null;
  vitaminB6Mg?: number | null;
  vitaminB7Mcg?: number | null;
  vitaminB9Mcg?: number | null;
  vitaminB12Mcg?: number | null;
  calciumMg?: number | null;
  ironMg?: number | null;
  magnesiumMg?: number | null;
  zincMg?: number | null;
  seleniumMcg?: number | null;
  copperMg?: number | null;
  manganeseMg?: number | null;
  chromiumMcg?: number | null;
  iodineMcg?: number | null;
  omega3Mg?: number | null;
  omega6Mg?: number | null;
}

const NUTRIENT_FIELDS: { key: keyof Supplement; label: string; unit: string }[] = [
  { key: "calories", label: "Calories", unit: "kcal" },
  { key: "proteinG", label: "Protein", unit: "g" },
  { key: "carbsG", label: "Carbs", unit: "g" },
  { key: "fatG", label: "Fat", unit: "g" },
  { key: "fiberG", label: "Fiber", unit: "g" },
  { key: "sugarG", label: "Sugar", unit: "g" },
  { key: "saturatedFatG", label: "Saturated Fat", unit: "g" },
  { key: "polyunsaturatedFatG", label: "Polyunsaturated Fat", unit: "g" },
  { key: "monounsaturatedFatG", label: "Monounsaturated Fat", unit: "g" },
  { key: "transFatG", label: "Trans Fat", unit: "g" },
  { key: "omega3Mg", label: "Omega-3", unit: "mg" },
  { key: "omega6Mg", label: "Omega-6", unit: "mg" },
  { key: "vitaminAMcg", label: "Vitamin A", unit: "mcg" },
  { key: "vitaminCMg", label: "Vitamin C", unit: "mg" },
  { key: "vitaminDMcg", label: "Vitamin D", unit: "mcg" },
  { key: "vitaminEMg", label: "Vitamin E", unit: "mg" },
  { key: "vitaminKMcg", label: "Vitamin K", unit: "mcg" },
  { key: "vitaminB1Mg", label: "B1 (Thiamin)", unit: "mg" },
  { key: "vitaminB2Mg", label: "B2 (Riboflavin)", unit: "mg" },
  { key: "vitaminB3Mg", label: "B3 (Niacin)", unit: "mg" },
  { key: "vitaminB5Mg", label: "B5 (Pantothenic)", unit: "mg" },
  { key: "vitaminB6Mg", label: "B6", unit: "mg" },
  { key: "vitaminB7Mcg", label: "B7 (Biotin)", unit: "mcg" },
  { key: "vitaminB9Mcg", label: "B9 (Folate)", unit: "mcg" },
  { key: "vitaminB12Mcg", label: "B12", unit: "mcg" },
  { key: "calciumMg", label: "Calcium", unit: "mg" },
  { key: "ironMg", label: "Iron", unit: "mg" },
  { key: "magnesiumMg", label: "Magnesium", unit: "mg" },
  { key: "zincMg", label: "Zinc", unit: "mg" },
  { key: "seleniumMcg", label: "Selenium", unit: "mcg" },
  { key: "copperMg", label: "Copper", unit: "mg" },
  { key: "manganeseMg", label: "Manganese", unit: "mg" },
  { key: "chromiumMcg", label: "Chromium", unit: "mcg" },
  { key: "iodineMcg", label: "Iodine", unit: "mcg" },
  { key: "cholesterolMg", label: "Cholesterol", unit: "mg" },
  { key: "sodiumMg", label: "Sodium", unit: "mg" },
  { key: "potassiumMg", label: "Potassium", unit: "mg" },
];

function formatDose(supp: Supplement): string {
  const parts: string[] = [];
  if (supp.amount != null && supp.unit) {
    parts.push(formatNutritionAmount(supp.amount, supp.unit));
  }
  if (supp.form) {
    parts.push(supp.form);
  }
  if (parts.length === 0 && supp.description) {
    return supp.description;
  }
  return parts.join(" · ");
}

export function SupplementStackPanel() {
  const stack = trpc.supplements.list.useQuery();
  const supplements: Supplement[] = stack.data ?? [];
  const hasCanonicalStack = stack.data !== undefined;

  if (stack.isLoading && !hasCanonicalStack) {
    return <QueryStatePanel variant="loading" height={80} />;
  }
  if (stack.error && !hasCanonicalStack) {
    return <QueryStatePanel error={stack.error} height={120} />;
  }

  return (
    <div className="space-y-3">
      {stack.error ? <QueryStatePanel error={stack.error} height={72} /> : null}
      {supplements.length === 0 ? (
        <QueryStatePanel variant="empty" message="No synced supplements available." height={72} />
      ) : null}
      {supplements.map((supp) => (
        <SupplementRow
          key={`${supp.name}-${supp.amount ?? ""}-${supp.unit ?? ""}-${supp.form ?? ""}-${supp.meal ?? ""}`}
          supp={supp}
        />
      ))}
    </div>
  );
}

function SupplementRow({ supp }: { supp: Supplement }) {
  const dose = formatDose(supp);
  const nutrients = NUTRIENT_FIELDS.filter(
    (field) => supp[field.key] != null && supp[field.key] !== 0,
  );

  return (
    <div className="flex items-center gap-3 rounded border border-border bg-page px-3 py-2">
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-sm text-foreground">{supp.name}</span>
          {dose && <span className="text-xs text-subtle">{dose}</span>}
          {supp.meal && <span className="text-[10px] text-dim uppercase">{supp.meal}</span>}
        </div>
        {nutrients.length > 0 && (
          <div className="flex flex-wrap gap-x-3 gap-y-0 mt-0.5">
            {nutrients.map((field) => (
              <span key={field.key} className="text-[10px] text-dim">
                {field.label}: {formatNutritionAmount(Number(supp[field.key]), field.unit)}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
