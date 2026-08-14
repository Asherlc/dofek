import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { reorderDashboardSections } from "../lib/dashboardGridPairs.ts";
import {
  type DashboardLayout,
  DashboardLayoutContext,
  DEFAULT_LAYOUT,
} from "../lib/dashboardLayoutContext.ts";
import { captureException } from "../lib/telemetry.ts";
import { trpc } from "../lib/trpc.ts";

const SETTINGS_KEY = "dashboardLayout";

const dashboardLayoutSchema = z.object({
  order: z.array(z.string()),
  hidden: z.array(z.string()),
  collapsed: z.record(z.string(), z.boolean()),
});

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

export function DashboardLayoutProvider({
  children,
  settingsEnabled,
}: {
  children: React.ReactNode;
  settingsEnabled: boolean;
}) {
  const [layout, setLayoutState] = useState<DashboardLayout>(DEFAULT_LAYOUT);
  const [writeError, setWriteError] = useState<string | null>(null);
  const lastReadError = useRef<unknown>(null);
  const lastInvalidValue = useRef<unknown>(null);

  const setting = trpc.settings.get.useQuery({ key: SETTINGS_KEY }, { enabled: settingsEnabled });
  const mutation = trpc.settings.set.useMutation();
  const utils = trpc.useUtils();

  // Load layout from server on mount
  useEffect(() => {
    if (setting.data?.value == null) {
      return;
    }
    let value = setting.data.value;
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch (error) {
        if (lastInvalidValue.current !== setting.data.value) {
          lastInvalidValue.current = setting.data.value;
          captureException(error, { context: "dashboard-layout-parse" });
        }
        return;
      }
    }
    const parsed = dashboardLayoutSchema.safeParse(value);
    if (parsed.success) {
      setLayoutState(normalizeLayout(parsed.data));
      return;
    }
    if (lastInvalidValue.current !== setting.data.value) {
      lastInvalidValue.current = setting.data.value;
      captureException(parsed.error, { context: "dashboard-layout-parse" });
    }
  }, [setting.data]);

  useEffect(() => {
    if (setting.error && lastReadError.current !== setting.error) {
      lastReadError.current = setting.error;
      captureException(setting.error, { context: "dashboard-layout-read" });
    }
  }, [setting.error]);

  const persist = useCallback(
    (newLayout: DashboardLayout, previousLayout: DashboardLayout) => {
      const previousSetting = utils.settings.get.getData({ key: SETTINGS_KEY });
      utils.settings.get.setData({ key: SETTINGS_KEY }, { key: SETTINGS_KEY, value: newLayout });
      setWriteError(null);
      mutation.mutate(
        { key: SETTINGS_KEY, value: newLayout },
        {
          onError: (error) => {
            setLayoutState(previousLayout);
            utils.settings.get.setData({ key: SETTINGS_KEY }, previousSetting);
            setWriteError(error.message);
            captureException(error, { context: "dashboard-layout-write" });
          },
          onSettled: () => {
            void utils.settings.get.invalidate({ key: SETTINGS_KEY });
          },
        },
      );
    },
    [mutation, utils],
  );

  const setOrder = useCallback(
    (order: string[]) => {
      setLayoutState((prev) => {
        const next = { ...prev, order };
        persist(next, prev);
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
        persist(next, prev);
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
        persist(next, prev);
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
        persist(next, prev);
        return next;
      });
    },
    [persist],
  );

  const resetLayout = useCallback(() => {
    setLayoutState((previousLayout) => {
      persist(DEFAULT_LAYOUT, previousLayout);
      return DEFAULT_LAYOUT;
    });
  }, [persist]);

  return (
    <>
      <DashboardLayoutContext
        value={{ layout, setOrder, toggleHidden, toggleCollapsed, moveSection, resetLayout }}
      >
        {children}
      </DashboardLayoutContext>
      {(writeError ?? setting.error?.message) && (
        <p
          role="alert"
          className="fixed bottom-4 right-4 z-50 rounded bg-red-950 px-3 py-2 text-sm text-red-200"
        >
          {writeError ?? setting.error?.message}
        </p>
      )}
    </>
  );
}
