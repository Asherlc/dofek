import { createFileRoute } from "@tanstack/react-router";
import { SupplementStackPanel } from "../../components/SupplementStackPanel.tsx";

export const Route = createFileRoute("/nutrition/supplements")({
  component: NutritionSupplementsPage,
});

function NutritionSupplementsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wider mb-1">
          Supplement Stack
        </h2>
        <p className="text-xs text-zinc-600 mb-4">Daily supplements synced as nutrition data</p>
      </div>
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-2 sm:p-4">
        <SupplementStackPanel />
      </div>
    </div>
  );
}
