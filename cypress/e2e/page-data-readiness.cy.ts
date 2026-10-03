describe("Page data readiness", () => {
  beforeEach(() => cy.login());
  afterEach(() => cy.cleanTestData());

  it("waits for the delayed required result and the visible genuine empty state", () => {
    cy.intercept("POST", "**/api/trpc/*heartRate.dailyBySource*", (request) => {
      request.continue((response) => response.setDelay(1200));
    }).as("heartRate");
    cy.visit("/body/heart-rate");
    cy.contains("Daily Heart Rate by Source").should("be.visible");
    cy.window().then((window) => {
      expect(window.performance.getEntriesByName("dofek.page.data-ready")).to.have.length(0);
    });
    cy.wait("@heartRate");
    cy.contains("No heart rate data for this day").should("be.visible");
    cy.window().should((window) => {
      const measures = window.performance.getEntriesByName("dofek.page.data-ready");
      expect(measures).to.have.length(1);
      const measure = measures[0];
      expect(measure?.duration).to.be.greaterThan(1200);
      if (!measure || !("detail" in measure)) throw new Error("Missing page readiness measure");
      expect(measure.detail).to.deep.include({
        route: "/body/heart-rate",
        kind: "navigation",
        outcome: "empty",
      });
      const response = window.performance
        .getEntriesByType("resource")
        .filter((entry) => entry.name.includes("heartRate.dailyBySource"))
        .at(-1);
      if (!response || !("responseEnd" in response) || typeof response.responseEnd !== "number")
        throw new Error("Missing heart-rate resource timing");
      expect((measure?.startTime ?? 0) + (measure?.duration ?? 0)).to.be.at.least(
        response.responseEnd,
      );
    });
  });

  it("records a separate date-filter generation after navigation completes", () => {
    cy.intercept("POST", "**/api/trpc/*heartRate.dailyBySource*", (request) => {
      request.continue((response) => response.setDelay(1200));
    }).as("heartRate");
    cy.visit("/body/heart-rate");
    cy.wait("@heartRate");
    cy.contains("No heart rate data for this day").should("be.visible");
    cy.window().should((window) =>
      expect(window.performance.getEntriesByName("dofek.page.data-ready")).to.have.length(1),
    );
    cy.get('button[aria-label="Previous day"]').click();
    cy.window().then((window) =>
      expect(window.performance.getEntriesByName("dofek.page.data-ready")).to.have.length(1),
    );
    cy.wait("@heartRate");
    cy.contains("No heart rate data for this day").should("be.visible");
    cy.window().should((window) => {
      const measures = window.performance.getEntriesByName("dofek.page.data-ready");
      expect(measures).to.have.length(2);
      const measure = measures[1];
      if (!measure || !("detail" in measure)) throw new Error("Missing filter readiness measure");
      expect(measure.detail).to.deep.include({
        kind: "filter",
        generation: 2,
        outcome: "empty",
      });
      expect(measures[1]?.duration).to.be.greaterThan(1200);
    });
  });
});
