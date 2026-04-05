import { useCallback, useEffect, useState } from "react";
import { reorderDashboardSections } from "../lib/dashboardGridPairs.ts";
import {
  type DashboardLayout,
  DashboardLayoutContext,
  DEFAULT_LAYOUT,
} from "../lib/dashboardLayoutContext.ts";
import { trpc } from "../lib/trpc.ts";

const SETTINGS_KEY = "dashboardLayout";

function isValidLayout(value: unknown): value is DashboardLayout {
  if (typeof value !== "object" || value === null) return false;
  return (
    "order" in value &&
    Array.isArray(value.order) &&
    "hidden" in value &&
    Array.isArray(value.hidden) &&
    "collapsed" in value &&
    typeof value.collapsed === "object" &&
    value.collapsed !== null
  );
}

function normalizeLayout(layout: DashboardLayout): DashboardLayout {
  const knownSections = new Set(DEFAULT_LAYOUT.order);
  const order = [...new Set(layout.order.filter((id) => knownSections.has(id)))];
  for (const id of DEFAULT_LAYOUT.order) {
    if (!order.includes(id)) order.push(id);
  }

  const hidden = [...new Set(layout.hidden.filter((id) => knownSections.has(id)))];
  const collapsed: Record<string, boolean> = {};
  for (const id of DEFAULT_LAYOUT.order) {
    collapsed[id] = layout.collapsed[id] ?? DEFAULT_LAYOUT.collapsed[id] ?? false;
  }

  return { order, hidden, collapsed };
}

export function DashboardLayoutProvider({ children }: { children: React.ReactNode }) {
  const [layout, setLayoutState] = useState<DashboardLayout>(DEFAULT_LAYOUT);

  const setting = trpc.settings.get.useQuery({ key: SETTINGS_KEY });
  const mutation = trpc.settings.set.useMutation();
  const utils = trpc.useUtils();

  // Load layout from server on mount
  useEffect(() => {
    if (setting.data?.value) {
      const parsed =
        typeof setting.data.value === "string"
          ? JSON.parse(setting.data.value)
          : setting.data.value;
      if (isValidLayout(parsed)) {
        const normalized = normalizeLayout(parsed);
        setLayoutState(normalized);
      }
    }
  }, [setting.data]);

  const persist = useCallback(
    (newLayout: DashboardLayout) => {
      mutation.mutate(
        { key: SETTINGS_KEY, value: JSON.stringify(newLayout) },
        { onSuccess: () => utils.settings.get.invalidate({ key: SETTINGS_KEY }) },
      );
    },
    [mutation, utils],
  );

  const setOrder = useCallback(
    (order: string[]) => {
      setLayoutState((prev) => {
        const next = { ...prev, order };
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const toggleHidden = useCallback(
    (id: string) => {
      setLayoutState((prev) => {
        const hidden = prev.hidden.includes(id)
          ? prev.hidden.filter((h) => h !== id)
          : [...prev.hidden, id];
        const next = { ...prev, hidden };
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const toggleCollapsed = useCallback(
    (id: string) => {
      setLayoutState((prev) => {
        const next = {
          ...prev,
          collapsed: { ...prev.collapsed, [id]: !prev.collapsed[id] },
        };
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const moveSection = useCallback(
    (id: string, direction: "up" | "down") => {
      setLayoutState((prev) => {
        const order = reorderDashboardSections(prev.order, id, direction);
        if (order === prev.order) {
          return prev;
        }

        const next = { ...prev, order };
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const resetLayout = useCallback(() => {
    setLayoutState(DEFAULT_LAYOUT);
    persist(DEFAULT_LAYOUT);
  }, [persist]);

  return (
    <DashboardLayoutContext
      value={{ layout, setOrder, toggleHidden, toggleCollapsed, moveSection, resetLayout }}
    >
      {children}
    </DashboardLayoutContext>
  );
}
