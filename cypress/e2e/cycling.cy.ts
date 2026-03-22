describe("Cycling Page", () => {
  beforeEach(() => {
    cy.login();
  });

  afterEach(() => {
    cy.cleanTestData();
  });

  it("loads without errors when user has no activity data", () => {
    cy.visit("/training/cycling");
    cy.url().should("include", "/training/cycling");
    cy.contains("Something went wrong").should("not.exist");
    cy.contains("Invalid Date").should("not.exist");
  });

  it("renders section headings", () => {
    cy.visit("/training/cycling");
    cy.contains("Power Duration Curve").should("be.visible");
    cy.contains("Fitness, Fatigue & Form").should("be.visible");
    cy.contains("Estimated Threshold Power Trend").should("be.visible");
    cy.contains("Aerobic Efficiency").should("be.visible");
    cy.contains("Vertical Ascent Rate").should("be.visible");
    cy.contains("Activity Variability Index").should("be.visible");
  });

  it("shows empty states for charts when no data exists", () => {
    cy.visit("/training/cycling");
    // Charts should show empty state messages, not crash
    cy.contains("No activities with sufficient Zone 2 power + heart rate data").should(
      "be.visible",
    );
    cy.contains("No activities with altitude data available").should("be.visible");
    cy.contains("No activities with power data available").should("be.visible");
  });

  it("aerobicEfficiency API returns valid response for empty data", () => {
    cy.request({
      url: "/api/trpc/efficiency.aerobicEfficiency?input=%7B%22json%22%3A%7B%22days%22%3A180%7D%7D",
      failOnStatusCode: false,
    }).then((res) => {
      expect(res.status).to.eq(200);
      const body = res.body;
      expect(body).to.have.property("result");
      expect(body.result).to.have.property("data");
      const data = body.result.data;
      expect(data).to.have.property("activities");
      expect(data.activities).to.be.an("array");
    });
  });
});
