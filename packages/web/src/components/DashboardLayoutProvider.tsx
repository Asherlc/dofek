import { useCallback, useEffect, useState } from "react";
import {
  type DashboardLayout,
  DashboardLayoutContext,
  DEFAULT_LAYOUT,
} from "../lib/dashboardLayoutContext.ts";
import { trpc } from "../lib/trpc.ts";

const SETTINGS_KEY = "dashboardLayout";

/** Grid-paired sections: if one moves, its pair moves with it. */
const GRID_PAIRS: Record<string, string> = {
  weeklyReport: "sleepNeed",
  sleepNeed: "weeklyReport",
  stress: "healthspan",
  healthspan: "stress",
  spo2Temp: "steps",
  steps: "spo2Temp",
};

function isValidLayout(value: unknown): value is DashboardLayout {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    Array.isArray(obj.order) &&
    Array.isArray(obj.hidden) &&
    typeof obj.collapsed === "object" &&
    obj.collapsed !== null
  );
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
        setLayoutState(parsed);
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
        const order = [...prev.order];
        const idx = order.indexOf(id);
        if (idx === -1) return prev;

        const pairId = GRID_PAIRS[id];
        // Collect the IDs to move (the section and its pair if any)
        const idsToMove = pairId ? [id, pairId] : [id];

        // Find all indices of the group
        const indices = idsToMove.map((sid) => order.indexOf(sid)).filter((i) => i !== -1);
        indices.sort((a, b) => a - b);

        if (indices.length === 0) return prev;

        if (direction === "up") {
          const minIdx = indices[0] ?? 0;
          if (minIdx <= 0) return prev;
          const targetIdx = minIdx - 1;
          const targetId = order[targetIdx] ?? "";
          const targetPairId = GRID_PAIRS[targetId];

          if (targetPairId && !idsToMove.includes(targetPairId)) {
            const targetPairIdx = order.indexOf(targetPairId);
            const jumpOver = Math.min(targetIdx, targetPairIdx);
            const jumpOverId = order[jumpOver] ?? "";
            const filtered = order.filter((s) => !idsToMove.includes(s));
            const insertAt = filtered.indexOf(jumpOverId);
            filtered.splice(insertAt, 0, ...idsToMove);
            const next = { ...prev, order: filtered };
            persist(next);
            return next;
          }

          const filtered = order.filter((s) => !idsToMove.includes(s));
          const insertAt = filtered.indexOf(targetId);
          filtered.splice(insertAt, 0, ...idsToMove);
          const next = { ...prev, order: filtered };
          persist(next);
          return next;
        }

        // direction === "down"
        const maxIdx = indices[indices.length - 1] ?? order.length - 1;
        if (maxIdx >= order.length - 1) return prev;
        const targetIdx = maxIdx + 1;
        const targetId = order[targetIdx] ?? "";
        const targetPairId = GRID_PAIRS[targetId];

        if (targetPairId && !idsToMove.includes(targetPairId)) {
          const targetPairIdx = order.indexOf(targetPairId);
          const jumpOver = Math.max(targetIdx, targetPairIdx);
          const insertAfterItem = order[jumpOver] ?? "";
          const filtered = order.filter((s) => !idsToMove.includes(s));
          const insertAt = filtered.indexOf(insertAfterItem) + 1;
          filtered.splice(insertAt, 0, ...idsToMove);
          const next = { ...prev, order: filtered };
          persist(next);
          return next;
        }

        const filtered = order.filter((s) => !idsToMove.includes(s));
        const insertAt = filtered.indexOf(targetId) + 1;
        filtered.splice(insertAt, 0, ...idsToMove);
        const next = { ...prev, order: filtered };
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
