import { createFileRoute } from "@tanstack/react-router";
import { PageSection } from "../../components/PageSection.tsx";
import { SupplementStackPanel } from "../../components/SupplementStackPanel.tsx";

export const Route = createFileRoute("/nutrition/supplements")({
  component: NutritionSupplementsPage,
});

function NutritionSupplementsPage() {
  return (
    <PageSection title="Supplement Stack" subtitle="Daily supplements synced as nutrition data">
      <SupplementStackPanel />
    </PageSection>
  );
}
