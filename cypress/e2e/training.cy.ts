describe("Training Page", () => {
  beforeEach(() => {
    cy.login();
  });

  afterEach(() => {
    cy.cleanTestData();
  });

  it("loads without errors", () => {
    cy.visit("/training");
    cy.url().should("include", "/training");
    cy.contains("Something went wrong").should("not.exist");
  });

  it("renders section headings", () => {
    cy.visit("/training");
    cy.contains("Training Calendar").should("be.visible");
    cy.contains("Fitness / Fatigue / Form").should("be.visible");
    cy.contains("Volume & Zones").should("be.visible");
  });

  it("renders sub-tab navigation", () => {
    cy.visit("/training");
    for (const tab of ["Overview", "Endurance", "Strength", "Hiking", "Recovery"]) {
      cy.contains(tab).should("be.visible");
    }
  });

  it("navigates to sub-tabs without errors", () => {
    const subtabs = [
      { label: "Endurance", path: "/training/endurance" },
      { label: "Strength", path: "/training/strength" },
      { label: "Hiking", path: "/training/hiking" },
      { label: "Recovery", path: "/training/recovery" },
    ];
    for (const { label, path } of subtabs) {
      cy.visit(path);
      cy.url().should("include", path);
      cy.contains(label).should("be.visible");
      cy.contains("Something went wrong").should("not.exist");
    }
  });

  it("weeklyVolume API returns valid data", () => {
    cy.request({
      url: "/api/trpc/training.weeklyVolume?input=%7B%22json%22%3A%7B%22days%22%3A90%7D%7D",
      failOnStatusCode: false,
    }).then((res) => {
      expect(res.status).to.eq(200);
      const body = res.body;
      expect(body).to.have.property("result");
      expect(body.result).to.have.property("data");
      const rows = body.result.data;
      expect(rows).to.be.an("array");
      // Verify hours is always a number (not a string) if rows exist
      for (const row of rows) {
        if (row.hours !== undefined) {
          expect(row.hours).to.be.a("number");
        }
      }
    });
  });
});
