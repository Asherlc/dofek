import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
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
    <PageLayout
      nav={
        <nav className="border-b border-border px-3 sm:px-6">
          <div className="mx-auto max-w-7xl flex gap-1 overflow-x-auto scrollbar-hide">
            {subtabs.map((tab) => (
              <Link
                key={tab.to}
                to={tab.to}
                activeOptions={{ exact: tab.exact }}
                className="px-3 py-2.5 text-xs transition-colors text-subtle hover:text-foreground whitespace-nowrap"
                activeProps={{
                  className:
                    "px-3 py-2.5 text-xs transition-colors text-foreground border-b-2 border-accent whitespace-nowrap",
                }}
              >
                {tab.label}
              </Link>
            ))}
          </div>
        </nav>
      }
    >
      <Outlet />
    </PageLayout>
  );
}
