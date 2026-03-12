import { useState } from "react";
import { trpc } from "../lib/trpc.ts";

interface Supplement {
  name: string;
  amount?: number;
  unit?: string;
  form?: string;
  description?: string;
  meal?: "breakfast" | "lunch" | "dinner" | "snack" | "other";
  calories?: number;
  proteinG?: number;
  carbsG?: number;
  fatG?: number;
  saturatedFatG?: number;
  polyunsaturatedFatG?: number;
  monounsaturatedFatG?: number;
  transFatG?: number;
  cholesterolMg?: number;
  sodiumMg?: number;
  potassiumMg?: number;
  fiberG?: number;
  sugarG?: number;
  vitaminAMcg?: number;
  vitaminCMg?: number;
  vitaminDMcg?: number;
  vitaminEMg?: number;
  vitaminKMcg?: number;
  vitaminB1Mg?: number;
  vitaminB2Mg?: number;
  vitaminB3Mg?: number;
  vitaminB5Mg?: number;
  vitaminB6Mg?: number;
  vitaminB7Mcg?: number;
  vitaminB9Mcg?: number;
  vitaminB12Mcg?: number;
  calciumMg?: number;
  ironMg?: number;
  magnesiumMg?: number;
  zincMg?: number;
  seleniumMcg?: number;
  copperMg?: number;
  manganeseMg?: number;
  chromiumMcg?: number;
  iodineMcg?: number;
  omega3Mg?: number;
  omega6Mg?: number;
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

  const supplements = (stack.data ?? []) as Supplement[];

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
    return <div className="h-20 rounded-lg bg-zinc-800 animate-pulse" />;
  }

  return (
    <div className="space-y-3">
      {supplements.length === 0 && !showAdd && (
        <p className="text-xs text-zinc-600">
          No supplements configured. Add your daily stack and it will be synced as nutrition data.
        </p>
      )}

      {supplements.map((supp, i) => (
        <div key={`${supp.name}-${i}`}>
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
          className="text-xs px-3 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-300 hover:bg-zinc-700 transition-colors"
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
    <div className="flex items-center gap-3 rounded border border-zinc-800 bg-zinc-950 px-3 py-2 group">
      <div className="flex flex-col gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {onMoveUp && (
          <button
            type="button"
            onClick={onMoveUp}
            className="text-[10px] text-zinc-600 hover:text-zinc-400"
          >
            ▲
          </button>
        )}
        {onMoveDown && (
          <button
            type="button"
            onClick={onMoveDown}
            className="text-[10px] text-zinc-600 hover:text-zinc-400"
          >
            ▼
          </button>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-sm text-zinc-200">{supp.name}</span>
          {dose && <span className="text-xs text-zinc-500">{dose}</span>}
          {supp.meal && <span className="text-[10px] text-zinc-600 uppercase">{supp.meal}</span>}
        </div>
        {nutrients.length > 0 && (
          <div className="flex flex-wrap gap-x-3 gap-y-0 mt-0.5">
            {nutrients.map((f) => (
              <span key={f.key} className="text-[10px] text-zinc-600">
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
        className="text-xs text-zinc-600 hover:text-zinc-300 transition-colors opacity-0 group-hover:opacity-100"
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
      const v = initial?.[f.key];
      vals[f.key] = v != null ? String(v) : "";
    }
    return vals;
  });

  const amountNum = amount ? Number(amount) : null;
  const hasAmount = amountNum != null && !Number.isNaN(amountNum) && amountNum > 0;
  const invalidNutrients = NUTRIENT_FIELDS.some((f) => {
    const v = nutrients[f.key];
    return v !== "" && (Number.isNaN(Number(v)) || Number(v) < 0);
  });
  const canSubmit = name.trim().length > 0 && !invalidNutrients && !saving;

  const handleSubmit = () => {
    const supp: Supplement = { name: name.trim() };
    if (hasAmount && amountNum != null) {
      supp.amount = amountNum;
      supp.unit = unit;
    }
    if (form) supp.form = form;
    if (meal) supp.meal = meal as Supplement["meal"];

    // Build description from amount + unit + form for the provider
    const descParts: string[] = [];
    if (supp.amount != null && supp.unit) descParts.push(`${supp.amount}${supp.unit}`);
    if (supp.form) descParts.push(supp.form);
    if (descParts.length > 0) supp.description = descParts.join(" ");

    for (const f of NUTRIENT_FIELDS) {
      const v = nutrients[f.key];
      if (v !== "" && !Number.isNaN(Number(v)) && Number(v) >= 0) {
        Object.assign(supp, { [f.key]: Number(v) });
      }
    }
    onSubmit(supp);
  };

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-3 space-y-3">
      <div className="grid grid-cols-12 gap-3">
        <div className="col-span-5">
          <label className="text-xs text-zinc-500 block mb-1">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., Creatine Monohydrate"
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500"
          />
        </div>
        <div className="col-span-2">
          <label className="text-xs text-zinc-500 block mb-1">Amount</label>
          <input
            type="number"
            step="any"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="5000"
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500 tabular-nums"
          />
        </div>
        <div className="col-span-1">
          <label className="text-xs text-zinc-500 block mb-1">Unit</label>
          <select
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-zinc-500"
          >
            {UNITS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </div>
        <div className="col-span-2">
          <label className="text-xs text-zinc-500 block mb-1">Form</label>
          <select
            value={form}
            onChange={(e) => setForm(e.target.value)}
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-zinc-500"
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
          <label className="text-xs text-zinc-500 block mb-1">Meal</label>
          <select
            value={meal}
            onChange={(e) => setMeal(e.target.value)}
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-zinc-500"
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
          className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          {showNutrients ? "▼" : "▶"} Nutritional values
        </button>
        {showNutrients && (
          <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2 mt-2">
            {NUTRIENT_FIELDS.map((f) => (
              <div key={f.key}>
                <label className="text-[10px] text-zinc-600 block mb-0.5">
                  {f.label} ({f.unit})
                </label>
                <input
                  type="number"
                  step="any"
                  value={nutrients[f.key]}
                  onChange={(e) => setNutrients((prev) => ({ ...prev, [f.key]: e.target.value }))}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-100 focus:outline-none focus:border-zinc-500 tabular-nums"
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
            className="text-xs px-3 py-1.5 rounded text-zinc-500 hover:text-zinc-300 transition-colors"
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
