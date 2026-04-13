import { createFileRoute, Outlet } from "@tanstack/react-router";
import { PageLayout } from "../components/PageLayout.tsx";

const subtabs = [
  { to: "/nutrition", label: "Daily Log", exact: true },
  { to: "/nutrition/analytics", label: "Analytics", exact: false },
  { to: "/nutrition/supplements", label: "Supplements", exact: false },
] as const;

export const Route = createFileRoute("/nutrition")({
  component: NutritionLayout,
});

function NutritionLayout() {
  return (
    <PageLayout tabs={subtabs}>
      <Outlet />
    </PageLayout>
  );
}
