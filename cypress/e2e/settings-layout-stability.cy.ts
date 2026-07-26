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
  supported: boolean;
}

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
    supported: win.PerformanceObserver?.supportedEntryTypes.includes("layout-shift") ?? false,
  };
  win.__dofekLayoutShiftMeasurement = measurement;

  if (!measurement.supported) return;

  const observer = new win.PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (!isLayoutShiftEntry(entry) || entry.hadRecentInput) continue;

      measurement.entries.push({
        sourceLabels: (entry.sources ?? [])
          .map((source) => sourceLabel(win, source))
          .filter((label): label is string => label !== null),
        startTime: entry.startTime,
        value: entry.value,
      });
    }
  });
  observer.observe({ type: "layout-shift", buffered: true });
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

describe("Settings layout stability", () => {
  beforeEach(() => {
    cy.login();
  });

  afterEach(() => {
    cy.cleanTestData();
  });

  for (const path of ["/settings", "/providers"]) {
    it(`keeps downstream settings content stable on a direct ${path} load`, () => {
      cy.intercept("POST", /\/api\/trpc\/.*sync\.providers/, (request) => {
        request.on("response", (response) => {
          response.setDelay(1_500);
        });
      }).as("providerInventory");

      let initialLinkedAccountsTop = 0;
      let initialBillingTop = 0;
      let finalLinkedAccountsTop = 0;
      let finalBillingTop = 0;
      let initialBillingHeight = 0;
      let initialDataSourcesHeight = 0;
      let billingHeightDelta = 0;
      let dataSourcesHeightDelta = 0;

      cy.visit(path, {
        onBeforeLoad: installLayoutShiftObserver,
      });
      cy.location("pathname").should("eq", "/settings");
      cy.contains("main section h3", "Linked Accounts").then(($heading) => {
        const heading = $heading.get(0);
        if (!heading) throw new Error("Linked Accounts heading was not rendered");
        initialLinkedAccountsTop = documentTop(heading);
      });
      cy.contains("main section h3", "Billing").then(($heading) => {
        const heading = $heading.get(0);
        if (!heading) throw new Error("Billing heading was not rendered");
        initialBillingTop = documentTop(heading);
        initialBillingHeight = sectionHeight(heading);
      });
      cy.contains("main section h3", "Data Sources").then(($heading) => {
        const heading = $heading.get(0);
        if (!heading) throw new Error("Data Sources heading was not rendered");
        initialDataSourcesHeight = sectionHeight(heading);
      });

      cy.wait("@providerInventory");
      cy.contains("main", "Apple Health").should("exist");
      cy.window().then(waitForPaint);

      cy.contains("main section h3", "Linked Accounts").then(($heading) => {
        const heading = $heading.get(0);
        if (!heading) throw new Error("Linked Accounts heading was not rendered");

        finalLinkedAccountsTop = documentTop(heading);
      });
      cy.contains("main section h3", "Billing").then(($heading) => {
        const heading = $heading.get(0);
        if (!heading) throw new Error("Billing heading was not rendered");
        finalBillingTop = documentTop(heading);
        billingHeightDelta = sectionHeight(heading) - initialBillingHeight;
      });
      cy.contains("main section h3", "Data Sources").then(($heading) => {
        const heading = $heading.get(0);
        if (!heading) throw new Error("Data Sources heading was not rendered");
        dataSourcesHeightDelta = sectionHeight(heading) - initialDataSourcesHeight;
      });

      cy.window().then((win) => {
        const measurement = win.__dofekLayoutShiftMeasurement;
        if (!measurement) throw new Error("Layout shift measurement was not installed");

        const cls = maximumLayoutShiftSession(measurement.entries);
        const sources = measurement.entries.flatMap((entry) => entry.sourceLabels);
        const downstreamDelta = Math.abs(
          finalLinkedAccountsTop - finalBillingTop - (initialLinkedAccountsTop - initialBillingTop),
        );
        cy.log(
          measurement.supported
            ? `CLS ${cls.toFixed(4)}; sources: ${sources.join(", ") || "none"}`
            : "Layout Shift API unavailable; downstream-position assertion remained active",
        );
        const evidence =
          `CLS ${cls.toFixed(4)}; sources: ${sources.join(", ") || "none"}; ` +
          `Billing height delta ${billingHeightDelta}px; ` +
          `Data Sources height delta ${dataSourcesHeightDelta}px; ` +
          `normalized downstream delta ${downstreamDelta}px`;
        expect(Math.abs(billingHeightDelta), evidence).to.be.lessThan(1);
        expect(Math.abs(dataSourcesHeightDelta), evidence).to.be.lessThan(1);
        expect(downstreamDelta, evidence).to.be.lessThan(1);
        expect(cls, evidence).to.be.at.most(0.1);
      });
    });
  }
});
