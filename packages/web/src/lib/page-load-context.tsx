import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type PageLoadStatus, PageLoadTracker } from "./page-load-tracker.ts";
import { capturePageLoad } from "./posthog.ts";

interface PageLoadContextValue {
  tracker: PageLoadTracker;
  generation: number | undefined;
  beginFilter: (startedAt: number) => void;
}
const PageLoadContext = createContext<PageLoadContextValue | null>(null);

// Retain the navigation event time while authentication and route code load.
let navigationStartedAt = 0;
let activeNavigation: { tracker: PageLoadTracker; generation: number } | undefined;
export function recordPageNavigationStart(startedAt: number): void {
  navigationStartedAt = startedAt;
  if (activeNavigation) activeNavigation.tracker.cancel(activeNavigation.generation, startedAt);
}
export function getPageNavigationStart(): number {
  return navigationStartedAt;
}

export function PageLoadProvider({
  children,
  route,
  sections,
  startedAt,
  enabled = true,
}: {
  children: ReactNode;
  route: string;
  sections: readonly string[];
  startedAt: number;
  enabled?: boolean;
}) {
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const [tracker] = useState(
    () =>
      new PageLoadTracker((event) => {
        if (!enabledRef.current) return;
        if (event.section === undefined) {
          performance.measure(
            event.outcome === "ready" || event.outcome === "empty"
              ? "dofek.page.data-ready"
              : "dofek.page.data-outcome",
            {
              start: event.startedAt,
              end: event.completedAt,
              detail: {
                route: event.route,
                kind: event.kind,
                outcome: event.outcome,
                generation: event.generation,
              },
            },
          );
        }
        capturePageLoad(event);
      }),
  );
  const [generation, setGeneration] = useState<number>();
  const generationRef = useRef<number | undefined>(undefined);
  const initialStart = useRef({ route, sections, kind: "navigation" as const, startedAt });
  useLayoutEffect(() => {
    generationRef.current = tracker.begin(initialStart.current);
    activeNavigation = { tracker, generation: generationRef.current };
    setGeneration(generationRef.current);
    return () => {
      if (generationRef.current !== undefined)
        tracker.cancel(generationRef.current, performance.now());
      if (activeNavigation?.tracker === tracker) activeNavigation = undefined;
    };
  }, [tracker]);
  const beginFilter = useCallback(
    (inputStartedAt: number) => {
      generationRef.current = tracker.begin({
        route,
        sections,
        kind: "filter",
        startedAt: inputStartedAt,
      });
      activeNavigation = { tracker, generation: generationRef.current };
      setGeneration(generationRef.current);
    },
    [route, sections, tracker],
  );
  const value = useMemo(
    () => ({ tracker, generation, beginFilter }),
    [tracker, generation, beginFilter],
  );
  return <PageLoadContext.Provider value={value}>{children}</PageLoadContext.Provider>;
}

export function usePageLoad() {
  return useContext(PageLoadContext);
}

export function usePageLoadSection(section: string) {
  const context = usePageLoad();
  const tracker = context?.tracker;
  const generation = context?.generation;
  const complete = useCallback(
    (status: PageLoadStatus, completedAt: number) => {
      if (tracker && generation !== undefined)
        tracker.report({ generation, section, status, completedAt });
    },
    [tracker, generation, section],
  );
  return { generation, complete };
}

export function usePageLoadDomSection(section: string, status: PageLoadStatus | undefined): void {
  const { complete, generation } = usePageLoadSection(section);
  useEffect(() => {
    if (status === undefined || generation === undefined) return;
    let active = true;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame((completedAt) => {
        if (active) complete(status, completedAt);
      });
    });
    return () => {
      active = false;
      cancelAnimationFrame(frame);
    };
  }, [complete, generation, status]);
}
