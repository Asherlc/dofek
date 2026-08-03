describe("Provider detail page", () => {
  beforeEach(() => {
    cy.login();
  });

  afterEach(() => {
    cy.cleanTestData();
  });

  it("blocks unavailable provider actions when opened directly by URL", () => {
    cy.visit("/providers/strava");
    cy.url().should("include", "/providers/strava");

    // Should not redirect to login
    cy.contains("Sign in to Dofek").should("not.exist");

    cy.contains("h1", "Provider not found").should("be.visible");
    cy.contains("This provider is unavailable.").should("be.visible");

    // Provider capabilities are unknown, so actions must remain blocked.
    cy.contains("Sync Controls").should("not.exist");
    cy.get("main").contains("a", "Back to Data Sources").should("be.visible");
  });

  it("unavailable-provider link navigates back to settings", () => {
    cy.visit("/providers/strava");
    cy.contains("h1", "Provider not found").should("be.visible");

    cy.get("main").contains("a", "Back to Data Sources").click();
    cy.url().should("include", "/settings");
  });
});
