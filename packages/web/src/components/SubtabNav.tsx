import { Link } from "@tanstack/react-router";

interface Subtab {
  to: string;
  label: string;
  exact: boolean;
}

export function SubtabNav({ tabs }: { tabs: readonly Subtab[] }) {
  return (
    <nav className="border-b border-border px-3 sm:px-6">
      <div className="mx-auto max-w-7xl flex gap-1 overflow-x-auto scrollbar-hide">
        {tabs.map((tab) => (
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
  );
}
