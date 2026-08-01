interface LayoutShiftSource {
  readonly node?: Node | null;
}

interface LayoutShiftPerformanceEntry extends PerformanceEntry {
  readonly hadRecentInput: boolean;
  readonly sources?: readonly LayoutShiftSource[];
  readonly value: number;
}

interface RecordedLayoutShift {
  readonly sourceLabels: readonly string[];
  readonly startTime: number;
  readonly value: number;
}

interface LayoutShiftMeasurement {
  readonly entries: RecordedLayoutShift[];
  observer: PerformanceObserver | null;
  supported: boolean;
}

const TARGET_RESPONSE_DELAY_MS = 6_000;

declare global {
  interface Window {
    __dofekLayoutShiftMeasurement?: LayoutShiftMeasurement;
  }
}

function isLayoutShiftEntry(entry: PerformanceEntry): entry is LayoutShiftPerformanceEntry {
  return (
    entry.entryType === "layout-shift" &&
    "hadRecentInput" in entry &&
    typeof entry.hadRecentInput === "boolean" &&
    "value" in entry &&
    typeof entry.value === "number"
  );
}

function sourceLabel(win: Window, source: LayoutShiftSource): string | null {
  if (!(source.node instanceof win.Element)) return null;

  const sectionHeading = source.node.closest("section")?.querySelector("h3")?.textContent?.trim();
  return sectionHeading || source.node.tagName.toLowerCase();
}

function installLayoutShiftObserver(win: Window): void {
  const measurement: LayoutShiftMeasurement = {
    entries: [],
    observer: null,
    supported: win.PerformanceObserver?.supportedEntryTypes.includes("layout-shift") ?? false,
  };
  win.__dofekLayoutShiftMeasurement = measurement;

  if (!measurement.supported) return;

  const observer = new win.PerformanceObserver((list) => {
    recordLayoutShifts(win, measurement, list.getEntries());
  });
  measurement.observer = observer;
  observer.observe({ type: "layout-shift", buffered: true });
}

function recordLayoutShifts(
  win: Window,
  measurement: LayoutShiftMeasurement,
  entries: readonly PerformanceEntry[],
): void {
  for (const entry of entries) {
    if (!isLayoutShiftEntry(entry) || entry.hadRecentInput) continue;

    measurement.entries.push({
      sourceLabels: (entry.sources ?? [])
        .map((source) => sourceLabel(win, source))
        .filter((label): label is string => label !== null),
      startTime: entry.startTime,
      value: entry.value,
    });
  }
}

function maximumLayoutShiftSession(entries: readonly RecordedLayoutShift[]): number {
  let maximum = 0;
  let sessionStart = 0;
  let previousEntryTime = 0;
  let sessionValue = 0;

  for (const entry of entries) {
    const continuesSession =
      sessionValue > 0 &&
      entry.startTime - previousEntryTime < 1_000 &&
      entry.startTime - sessionStart < 5_000;

    if (continuesSession) {
      sessionValue += entry.value;
    } else {
      sessionStart = entry.startTime;
      sessionValue = entry.value;
    }

    previousEntryTime = entry.startTime;
    maximum = Math.max(maximum, sessionValue);
  }

  return maximum;
}

function documentTop(element: Element): number {
  const view = element.ownerDocument.defaultView;
  if (!view) throw new Error("The settings document has no window");
  return element.getBoundingClientRect().top + view.scrollY;
}

function sectionHeight(heading: Element): number {
  const section = heading.closest("section");
  if (!section) throw new Error(`The ${heading.textContent ?? "unknown"} heading has no section`);
  return section.getBoundingClientRect().height;
}

function waitForPaint(win: Window): Promise<void> {
  return new Promise((resolve) => {
    win.requestAnimationFrame(() => {
      win.requestAnimationFrame(() => resolve());
    });
  });
}

function waitForPendingPageResources(win: Window): Promise<void> {
  const imageLoads = Array.from(win.document.images)
    .filter((image) => !image.complete)
    .map(
      (image) =>
        new Promise<void>((resolve) => {
          image.addEventListener("load", () => resolve(), { once: true });
          image.addEventListener("error", () => resolve(), { once: true });
        }),
    );
  const resourcesReady = Promise.all([win.document.fonts.ready, ...imageLoads]).then(
    () => undefined,
  );

  return new Promise((resolve) => {
    const timeoutId = win.setTimeout(resolve, 2_000);
    resourcesReady.then(() => {
      win.clearTimeout(timeoutId);
      resolve();
    });
  });
}

function waitForLayoutShiftQuietWindow(win: Window, disconnectObserver: boolean): Promise<void> {
  const measurement = win.__dofekLayoutShiftMeasurement;
  if (!measurement) throw new Error("Layout shift measurement was not installed");

  const observer = measurement.observer;
  if (!observer) return Promise.resolve();

  return new Promise((resolve) => {
    const startedAt = win.performance.now();
    let quietSince = startedAt;
    let recordedEntryCount = measurement.entries.length;

    const checkForQuietWindow = () => {
      recordLayoutShifts(win, measurement, observer.takeRecords());

      const now = win.performance.now();
      if (measurement.entries.length !== recordedEntryCount) {
        recordedEntryCount = measurement.entries.length;
        quietSince = now;
      }

      if (now - quietSince >= 500 || now - startedAt >= 3_000) {
        if (disconnectObserver) observer.disconnect();
        resolve();
        return;
      }

      win.setTimeout(checkForQuietWindow, 50);
    };

    win.setTimeout(checkForQuietWindow, 50);
  });
}

async function waitForStableLayout(win: Window, disconnectObserver: boolean): Promise<void> {
  await waitForPendingPageResources(win);
  await waitForPaint(win);
  await waitForLayoutShiftQuietWindow(win, disconnectObserver);
}

describe("Settings layout stability", () => {
  beforeEach(() => {
    cy.login();
  });

  afterEach(() => {
    cy.cleanTestData();
  });

  for (const path of ["/settings?tab=data-sources", "/providers"]) {
    it(`keeps connection settings stable on a direct ${path} load`, () => {
      cy.intercept("POST", /\/api\/trpc\/.*sync\.providers/, (request) => {
        request.on("response", (response) => {
          response.setDelay(TARGET_RESPONSE_DELAY_MS);
        });
      }).as("providerInventory");

      let initialZeppPairingTop = 0;
      let finalZeppPairingTop = 0;
      let initialDataSourcesTop = 0;
      let finalDataSourcesTop = 0;
      let initialDataSourcesHeight = 0;
      let dataSourcesHeightDelta = 0;

      cy.visit(path, {
        onBeforeLoad: installLayoutShiftObserver,
      });
      cy.location("pathname").should("eq", "/settings");
      cy.location("search").should("contain", "tab=data-sources");
      cy.window().then((win) => waitForStableLayout(win, false));
      cy.get('section[aria-label="Available data sources"]').should(
        "have.attr",
        "aria-busy",
        "true",
      );
      cy.contains("main section h3", "Zepp App Pairing").then(($heading) => {
        const heading = $heading.get(0);
        if (!heading) throw new Error("Zepp App Pairing heading was not rendered");
        initialZeppPairingTop = documentTop(heading);
      });
      cy.contains("main section h3", "Data Sources").then(($heading) => {
        const heading = $heading.get(0);
        if (!heading) throw new Error("Data Sources heading was not rendered");
        initialDataSourcesTop = documentTop(heading);
        initialDataSourcesHeight = sectionHeight(heading);
      });

      cy.wait("@providerInventory");
      cy.contains("main", "Apple Health").should("exist");
      cy.window().then((win) => waitForStableLayout(win, true));

      cy.contains("main section h3", "Zepp App Pairing").then(($heading) => {
        const heading = $heading.get(0);
        if (!heading) throw new Error("Zepp App Pairing heading was not rendered");
        finalZeppPairingTop = documentTop(heading);
      });
      cy.contains("main section h3", "Data Sources").then(($heading) => {
        const heading = $heading.get(0);
        if (!heading) throw new Error("Data Sources heading was not rendered");
        finalDataSourcesTop = documentTop(heading);
        dataSourcesHeightDelta = sectionHeight(heading) - initialDataSourcesHeight;
      });

      cy.window().then((win) => {
        const measurement = win.__dofekLayoutShiftMeasurement;
        if (!measurement) throw new Error("Layout shift measurement was not installed");

        const cls = maximumLayoutShiftSession(measurement.entries);
        const sources = measurement.entries.flatMap((entry) => entry.sourceLabels);
        const downstreamDelta = Math.abs(
          finalZeppPairingTop -
            finalDataSourcesTop -
            (initialZeppPairingTop - initialDataSourcesTop),
        );
        cy.log(
          measurement.supported
            ? `CLS ${cls.toFixed(4)}; sources: ${sources.join(", ") || "none"}`
            : "Layout Shift API unavailable; downstream-position assertion remained active",
        );
        const evidence =
          `CLS ${cls.toFixed(4)}; sources: ${sources.join(", ") || "none"}; ` +
          `Data Sources height delta ${dataSourcesHeightDelta}px; ` +
          `normalized Zepp App Pairing delta ${downstreamDelta}px`;
        expect(Math.abs(dataSourcesHeightDelta), evidence).to.be.lessThan(1);
        expect(downstreamDelta, evidence).to.be.lessThan(1);
        expect(cls, evidence).to.be.at.most(0.001);
      });
    });
  }

  it("keeps billing settings stable while Billing resolves", () => {
    cy.intercept("POST", /\/api\/trpc\/.*billing\.status/, (request) => {
      request.on("response", (response) => {
        response.setDelay(TARGET_RESPONSE_DELAY_MS);
      });
    }).as("billingStatus");

    let initialBillingTop = 0;
    let finalBillingTop = 0;
    let initialBillingHeight = 0;
    let billingHeightDelta = 0;

    cy.visit("/settings?tab=billing", {
      onBeforeLoad: installLayoutShiftObserver,
    });
    cy.window().then((win) => waitForStableLayout(win, false));
    cy.contains("main", "Loading subscription status...").should("exist");
    cy.contains("main section h3", "Billing").then(($heading) => {
      const heading = $heading.get(0);
      if (!heading) throw new Error("Billing heading was not rendered");
      initialBillingTop = documentTop(heading);
      initialBillingHeight = sectionHeight(heading);
    });

    cy.wait("@billingStatus");
    cy.contains("main", /full access|signup week/i).should("exist");
    cy.window().then((win) => waitForStableLayout(win, true));

    cy.contains("main section h3", "Billing").then(($heading) => {
      const heading = $heading.get(0);
      if (!heading) throw new Error("Billing heading was not rendered");
      finalBillingTop = documentTop(heading);
      billingHeightDelta = sectionHeight(heading) - initialBillingHeight;
    });

    cy.window().then((win) => {
      const measurement = win.__dofekLayoutShiftMeasurement;
      if (!measurement) throw new Error("Layout shift measurement was not installed");

      const cls = maximumLayoutShiftSession(measurement.entries);
      const sources = measurement.entries.flatMap((entry) => entry.sourceLabels);
      const evidence =
        `CLS ${cls.toFixed(4)}; sources: ${sources.join(", ") || "none"}; ` +
        `Billing height delta ${billingHeightDelta}px; ` +
        `Billing top ${initialBillingTop}px → ${finalBillingTop}px; ` +
        `Billing top delta ${Math.abs(finalBillingTop - initialBillingTop)}px`;
      cy.log(evidence);
      expect(Math.abs(billingHeightDelta), evidence).to.be.lessThan(1);
      expect(Math.abs(finalBillingTop - initialBillingTop), evidence).to.be.lessThan(1);
      expect(cls, evidence).to.be.at.most(0.001);
    });
  });
});
