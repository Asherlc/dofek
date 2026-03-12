import { useEffect, useRef, useState } from "react";

export type MealType = "breakfast" | "lunch" | "dinner" | "snack" | "other";

export interface FoodFormData {
  foodName: string;
  meal: MealType;
  calories: number;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
  foodDescription: string;
}

interface AddFoodModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (data: FoodFormData) => void;
  defaultMealType?: MealType;
  submitting?: boolean;
}

const mealOptions: { value: MealType; label: string }[] = [
  { value: "breakfast", label: "Breakfast" },
  { value: "lunch", label: "Lunch" },
  { value: "dinner", label: "Dinner" },
  { value: "snack", label: "Snack" },
  { value: "other", label: "Other" },
];

export function AddFoodModal({
  isOpen,
  onClose,
  onSubmit,
  defaultMealType = "breakfast",
  submitting = false,
}: AddFoodModalProps) {
  const [foodName, setFoodName] = useState("");
  const [mealType, setMealType] = useState<MealType>(defaultMealType);
  const [calories, setCalories] = useState("");
  const [proteinGrams, setProteinGrams] = useState("");
  const [carbsGrams, setCarbsGrams] = useState("");
  const [fatGrams, setFatGrams] = useState("");
  const [servingDescription, setServingDescription] = useState("");
  const [showMacros, setShowMacros] = useState(false);

  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setMealType(defaultMealType);
      nameInputRef.current?.focus();
    }
  }, [isOpen, defaultMealType]);

  function resetForm() {
    setFoodName("");
    setCalories("");
    setProteinGrams("");
    setCarbsGrams("");
    setFatGrams("");
    setServingDescription("");
    setShowMacros(false);
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const parsedCalories = Number.parseInt(calories, 10);
    if (!foodName.trim() || Number.isNaN(parsedCalories)) return;

    onSubmit({
      foodName: foodName.trim(),
      meal: mealType,
      calories: parsedCalories,
      proteinG: proteinGrams ? Number.parseFloat(proteinGrams) : null,
      carbsG: carbsGrams ? Number.parseFloat(carbsGrams) : null,
      fatG: fatGrams ? Number.parseFloat(fatGrams) : null,
      foodDescription: servingDescription.trim(),
    });
    resetForm();
  }

  function handleClose() {
    resetForm();
    onClose();
  }

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Overlay */}
      <div
        role="button"
        tabIndex={-1}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={handleClose}
        onKeyDown={(e) => {
          if (e.key === "Escape") handleClose();
        }}
        aria-label="Close modal overlay"
      />

      {/* Modal */}
      <div className="relative w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-4">
          <h2 className="text-lg font-semibold text-zinc-100">Add Food</h2>
          <button
            type="button"
            onClick={handleClose}
            className="text-zinc-500 hover:text-zinc-300 transition-colors"
            aria-label="Close"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="w-5 h-5"
            >
              <title>Close</title>
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-4">
          {/* Food name */}
          <div>
            <label htmlFor="food-name" className="block text-sm font-medium text-zinc-400 mb-1">
              Food name *
            </label>
            <input
              ref={nameInputRef}
              id="food-name"
              type="text"
              required
              value={foodName}
              onChange={(e) => setFoodName(e.target.value)}
              placeholder="e.g. Chicken breast"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
          </div>

          {/* Meal type */}
          <div>
            <label htmlFor="meal-type" className="block text-sm font-medium text-zinc-400 mb-1">
              Meal
            </label>
            <select
              id="meal-type"
              value={mealType}
              onChange={(e) => setMealType(e.target.value as MealType)}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            >
              {mealOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* Calories */}
          <div>
            <label htmlFor="calories" className="block text-sm font-medium text-zinc-400 mb-1">
              Calories *
            </label>
            <input
              id="calories"
              type="number"
              required
              min="0"
              value={calories}
              onChange={(e) => setCalories(e.target.value)}
              placeholder="e.g. 250"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
          </div>

          {/* Serving description */}
          <div>
            <label
              htmlFor="serving-description"
              className="block text-sm font-medium text-zinc-400 mb-1"
            >
              Serving description
            </label>
            <input
              id="serving-description"
              type="text"
              value={servingDescription}
              onChange={(e) => setServingDescription(e.target.value)}
              placeholder="e.g. 6 oz grilled"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
          </div>

          {/* Toggle macros */}
          {!showMacros && (
            <button
              type="button"
              onClick={() => setShowMacros(true)}
              className="text-sm text-emerald-400 hover:text-emerald-300 transition-colors"
            >
              + Add macros (protein, carbs, fat)
            </button>
          )}

          {/* Macro fields */}
          {showMacros && (
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label htmlFor="protein" className="block text-sm font-medium text-zinc-400 mb-1">
                  Protein (g)
                </label>
                <input
                  id="protein"
                  type="number"
                  min="0"
                  step="0.1"
                  value={proteinGrams}
                  onChange={(e) => setProteinGrams(e.target.value)}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                />
              </div>
              <div>
                <label htmlFor="carbs" className="block text-sm font-medium text-zinc-400 mb-1">
                  Carbs (g)
                </label>
                <input
                  id="carbs"
                  type="number"
                  min="0"
                  step="0.1"
                  value={carbsGrams}
                  onChange={(e) => setCarbsGrams(e.target.value)}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                />
              </div>
              <div>
                <label htmlFor="fat" className="block text-sm font-medium text-zinc-400 mb-1">
                  Fat (g)
                </label>
                <input
                  id="fat"
                  type="number"
                  min="0"
                  step="0.1"
                  value={fatGrams}
                  onChange={(e) => setFatGrams(e.target.value)}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                />
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={handleClose}
              className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !foodName.trim() || !calories}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? "Saving..." : "Add Food"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
