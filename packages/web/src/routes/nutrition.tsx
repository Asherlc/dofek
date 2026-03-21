import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { AppHeader } from "../components/AppHeader.tsx";

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
    <div className="min-h-screen bg-zinc-950 text-zinc-100 overflow-x-hidden">
      <AppHeader />
      <nav className="border-b border-zinc-800 px-3 sm:px-6">
        <div className="mx-auto max-w-7xl flex gap-1 overflow-x-auto scrollbar-hide">
          {subtabs.map((tab) => (
            <Link
              key={tab.to}
              to={tab.to}
              activeOptions={{ exact: tab.exact }}
              className="px-3 py-2.5 text-xs transition-colors text-zinc-500 hover:text-zinc-300 whitespace-nowrap"
              activeProps={{
                className:
                  "px-3 py-2.5 text-xs transition-colors text-zinc-100 border-b-2 border-emerald-500 whitespace-nowrap",
              }}
            >
              {tab.label}
            </Link>
          ))}
        </div>
      </nav>
      <main className="mx-auto max-w-7xl px-3 sm:px-6 py-4 sm:py-6">
        <Outlet />
      </main>
    </div>
  );
}
