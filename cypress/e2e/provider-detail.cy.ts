describe("Provider detail page", () => {
  beforeEach(() => {
    cy.login();
  });

  afterEach(() => {
    cy.cleanTestData();
  });

  it("loads provider detail page directly by URL", () => {
    cy.visit("/providers/strava");
    cy.url().should("include", "/providers/strava");

    // Should not redirect to login
    cy.contains("Sign in to view your health data").should("not.exist");

    // Should render the provider name
    cy.contains("h1", "Strava").should("be.visible");

    // Should render sync controls
    cy.contains("Sync Controls").should("be.visible");

    // Breadcrumb should link back to providers list
    cy.get("main").contains("a", "Providers").should("be.visible");
  });

  it("breadcrumb navigates back to providers list", () => {
    cy.visit("/providers/strava");
    cy.contains("h1", "Strava").should("be.visible");

    // Click the breadcrumb
    cy.get("main").contains("a", "Providers").click();
    cy.url().should("match", /\/providers\/?$/);
  });
});
