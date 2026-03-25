import { useState } from "react";
import { trpc } from "../lib/trpc.ts";

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

const MEALS = ["breakfast", "lunch", "dinner", "snack", "other"] as const;
const UNITS = ["mg", "g", "mcg", "IU", "ml", "oz"] as const;
const FORMS = ["capsule", "softgel", "tablet", "powder", "liquid", "gummy", "drop"] as const;

const NUTRIENT_FIELDS: { key: keyof Supplement; label: string; unit: string }[] = [
  // Macros
  { key: "calories", label: "Calories", unit: "kcal" },
  { key: "proteinG", label: "Protein", unit: "g" },
  { key: "carbsG", label: "Carbs", unit: "g" },
  { key: "fatG", label: "Fat", unit: "g" },
  { key: "fiberG", label: "Fiber", unit: "g" },
  { key: "sugarG", label: "Sugar", unit: "g" },
  // Fat breakdown
  { key: "saturatedFatG", label: "Saturated Fat", unit: "g" },
  { key: "polyunsaturatedFatG", label: "Polyunsaturated Fat", unit: "g" },
  { key: "monounsaturatedFatG", label: "Monounsaturated Fat", unit: "g" },
  { key: "transFatG", label: "Trans Fat", unit: "g" },
  { key: "omega3Mg", label: "Omega-3", unit: "mg" },
  { key: "omega6Mg", label: "Omega-6", unit: "mg" },
  // Vitamins
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
  // Minerals
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
    parts.push(`${supp.amount}${supp.unit}`);
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
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const utils = trpc.useUtils();
  const stack = trpc.supplements.list.useQuery();
  const saveMutation = trpc.supplements.save.useMutation({
    onSuccess: () => utils.supplements.list.invalidate(),
  });

  const supplements: Supplement[] = stack.data ?? [];

  const handleSave = (updated: Supplement[]) => {
    saveMutation.mutate({ supplements: updated });
  };

  const handleAdd = (supp: Supplement) => {
    handleSave([...supplements, supp]);
    setShowAdd(false);
  };

  const handleUpdate = (index: number, supp: Supplement) => {
    const updated = [...supplements];
    updated[index] = supp;
    handleSave(updated);
    setEditingIndex(null);
  };

  const handleRemove = (index: number) => {
    handleSave(supplements.filter((_, i) => i !== index));
    setEditingIndex(null);
  };

  const handleReorder = (from: number, to: number) => {
    const updated = [...supplements];
    const [moved] = updated.splice(from, 1);
    if (moved) updated.splice(to, 0, moved);
    handleSave(updated);
  };

  if (stack.isLoading) {
    return <div className="h-20 rounded-lg bg-skeleton animate-pulse" />;
  }

  return (
    <div className="space-y-3">
      {supplements.length === 0 && !showAdd && (
        <p className="text-xs text-dim">
          No supplements configured. Add your daily stack and it will be synced as nutrition data.
        </p>
      )}

      {supplements.map((supp, i) => (
        <div
          key={`${supp.name}-${supp.amount ?? ""}-${supp.unit ?? ""}-${supp.form ?? ""}-${supp.meal ?? ""}`}
        >
          {editingIndex === i ? (
            <SupplementForm
              initial={supp}
              onSubmit={(s) => handleUpdate(i, s)}
              onCancel={() => setEditingIndex(null)}
              onDelete={() => handleRemove(i)}
              saving={saveMutation.isPending}
            />
          ) : (
            <SupplementRow
              supp={supp}
              onEdit={() => setEditingIndex(i)}
              onMoveUp={i > 0 ? () => handleReorder(i, i - 1) : undefined}
              onMoveDown={i < supplements.length - 1 ? () => handleReorder(i, i + 1) : undefined}
            />
          )}
        </div>
      ))}

      {showAdd ? (
        <SupplementForm
          onSubmit={handleAdd}
          onCancel={() => setShowAdd(false)}
          saving={saveMutation.isPending}
        />
      ) : (
        <button
          type="button"
          onClick={() => setShowAdd(true)}
          className="text-xs px-3 py-1.5 rounded-lg bg-accent/10 border border-border-strong text-foreground hover:bg-surface-hover transition-colors"
        >
          + Add supplement
        </button>
      )}

      {saveMutation.isError && (
        <p className="text-xs text-red-500">Failed to save: {saveMutation.error.message}</p>
      )}
    </div>
  );
}

function SupplementRow({
  supp,
  onEdit,
  onMoveUp,
  onMoveDown,
}: {
  supp: Supplement;
  onEdit: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}) {
  const dose = formatDose(supp);
  const nutrients = NUTRIENT_FIELDS.filter((f) => supp[f.key] != null && supp[f.key] !== 0);

  return (
    <div className="flex items-center gap-3 rounded border border-border bg-page px-3 py-2 group">
      <div className="flex flex-col gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {onMoveUp && (
          <button
            type="button"
            onClick={onMoveUp}
            className="text-[10px] text-dim hover:text-muted"
          >
            ▲
          </button>
        )}
        {onMoveDown && (
          <button
            type="button"
            onClick={onMoveDown}
            className="text-[10px] text-dim hover:text-muted"
          >
            ▼
          </button>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-sm text-foreground">{supp.name}</span>
          {dose && <span className="text-xs text-subtle">{dose}</span>}
          {supp.meal && <span className="text-[10px] text-dim uppercase">{supp.meal}</span>}
        </div>
        {nutrients.length > 0 && (
          <div className="flex flex-wrap gap-x-3 gap-y-0 mt-0.5">
            {nutrients.map((f) => (
              <span key={f.key} className="text-[10px] text-dim">
                {f.label}: {supp[f.key]}
                {f.unit}
              </span>
            ))}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onEdit}
        className="text-xs text-dim hover:text-foreground transition-colors opacity-0 group-hover:opacity-100"
      >
        Edit
      </button>
    </div>
  );
}

function SupplementForm({
  initial,
  onSubmit,
  onCancel,
  onDelete,
  saving,
}: {
  initial?: Supplement;
  onSubmit: (s: Supplement) => void;
  onCancel: () => void;
  onDelete?: () => void;
  saving: boolean;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [amount, setAmount] = useState(initial?.amount != null ? String(initial.amount) : "");
  const [unit, setUnit] = useState(initial?.unit ?? "mg");
  const [form, setForm] = useState(initial?.form ?? "");
  const [meal, setMeal] = useState<string>(initial?.meal ?? "");
  const [showNutrients, setShowNutrients] = useState(
    NUTRIENT_FIELDS.some((f) => initial?.[f.key] != null && initial[f.key] !== 0),
  );
  const [nutrients, setNutrients] = useState<Record<string, string>>(() => {
    const vals: Record<string, string> = {};
    for (const f of NUTRIENT_FIELDS) {
      const fieldValue = initial?.[f.key];
      vals[f.key] = fieldValue != null ? String(fieldValue) : "";
    }
    return vals;
  });

  const amountNum = amount ? Number(amount) : null;
  const hasAmount = amountNum != null && !Number.isNaN(amountNum) && amountNum > 0;
  const invalidNutrients = NUTRIENT_FIELDS.some((f) => {
    const fieldValue = nutrients[f.key];
    return fieldValue !== "" && (Number.isNaN(Number(fieldValue)) || Number(fieldValue) < 0);
  });
  const canSubmit = name.trim().length > 0 && !invalidNutrients && !saving;

  const handleSubmit = () => {
    const supp: Supplement = { name: name.trim() };
    if (hasAmount && amountNum != null) {
      supp.amount = amountNum;
      supp.unit = unit;
    }
    if (form) supp.form = form;
    if (
      meal === "breakfast" ||
      meal === "lunch" ||
      meal === "dinner" ||
      meal === "snack" ||
      meal === "other"
    ) {
      supp.meal = meal;
    }

    // Build description from amount + unit + form for the provider
    const descParts: string[] = [];
    if (supp.amount != null && supp.unit) descParts.push(`${supp.amount}${supp.unit}`);
    if (supp.form) descParts.push(supp.form);
    if (descParts.length > 0) supp.description = descParts.join(" ");

    for (const f of NUTRIENT_FIELDS) {
      const fieldValue = nutrients[f.key];
      if (fieldValue !== "" && !Number.isNaN(Number(fieldValue)) && Number(fieldValue) >= 0) {
        Object.assign(supp, { [f.key]: Number(fieldValue) });
      }
    }
    onSubmit(supp);
  };

  return (
    <div className="card p-3 space-y-3">
      <div className="grid grid-cols-12 gap-3">
        <div className="col-span-5">
          <label htmlFor="supplement-name" className="text-xs text-subtle block mb-1">
            Name
          </label>
          <input
            id="supplement-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., Creatine Monohydrate"
            className="w-full bg-accent/10 border border-border-strong rounded px-3 py-1.5 text-sm text-foreground placeholder:text-dim focus:outline-none focus:border-accent"
          />
        </div>
        <div className="col-span-2">
          <label htmlFor="supplement-amount" className="text-xs text-subtle block mb-1">
            Amount
          </label>
          <input
            id="supplement-amount"
            type="number"
            step="any"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="5000"
            className="w-full bg-accent/10 border border-border-strong rounded px-3 py-1.5 text-sm text-foreground placeholder:text-dim focus:outline-none focus:border-accent tabular-nums"
          />
        </div>
        <div className="col-span-1">
          <label htmlFor="supplement-unit" className="text-xs text-subtle block mb-1">
            Unit
          </label>
          <select
            id="supplement-unit"
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            className="w-full bg-accent/10 border border-border-strong rounded px-2 py-1.5 text-sm text-foreground focus:outline-none focus:border-accent"
          >
            {UNITS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </div>
        <div className="col-span-2">
          <label htmlFor="supplement-form" className="text-xs text-subtle block mb-1">
            Form
          </label>
          <select
            id="supplement-form"
            value={form}
            onChange={(e) => setForm(e.target.value)}
            className="w-full bg-accent/10 border border-border-strong rounded px-2 py-1.5 text-sm text-foreground focus:outline-none focus:border-accent"
          >
            <option value="">—</option>
            {FORMS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </div>
        <div className="col-span-2">
          <label htmlFor="supplement-meal" className="text-xs text-subtle block mb-1">
            Meal
          </label>
          <select
            id="supplement-meal"
            value={meal}
            onChange={(e) => setMeal(e.target.value)}
            className="w-full bg-accent/10 border border-border-strong rounded px-2 py-1.5 text-sm text-foreground focus:outline-none focus:border-accent"
          >
            <option value="">—</option>
            {MEALS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <button
          type="button"
          onClick={() => setShowNutrients(!showNutrients)}
          className="text-xs text-subtle hover:text-foreground transition-colors"
        >
          {showNutrients ? "▼" : "▶"} Nutritional values
        </button>
        {showNutrients && (
          <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2 mt-2">
            {NUTRIENT_FIELDS.map((f) => (
              <div key={f.key}>
                <label
                  htmlFor={`supplement-nutrient-${f.key}`}
                  className="text-[10px] text-dim block mb-0.5"
                >
                  {f.label} ({f.unit})
                </label>
                <input
                  id={`supplement-nutrient-${f.key}`}
                  type="number"
                  step="any"
                  value={nutrients[f.key]}
                  onChange={(e) => setNutrients((prev) => ({ ...prev, [f.key]: e.target.value }))}
                  className="w-full bg-accent/10 border border-border-strong rounded px-2 py-1 text-xs text-foreground focus:outline-none focus:border-accent tabular-nums"
                />
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex gap-2 justify-between">
        <div>
          {onDelete && (
            <button
              type="button"
              onClick={onDelete}
              className="text-xs text-red-800 hover:text-red-500 transition-colors"
            >
              Remove
            </button>
          )}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="text-xs px-3 py-1.5 rounded text-subtle hover:text-foreground transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={handleSubmit}
            className="text-xs px-4 py-1.5 rounded bg-blue-800 text-blue-100 hover:bg-blue-700 disabled:opacity-40 transition-colors"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
