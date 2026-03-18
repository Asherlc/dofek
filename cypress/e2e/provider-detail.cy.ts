describe("Provider detail page", () => {
  beforeEach(() => {
    cy.login();
  });

  afterEach(() => {
    cy.cleanTestData();
  });

  it("navigates to provider detail when clicking Details link", () => {
    cy.visit("/providers");
    cy.url().should("include", "/providers");

    // The providers page should have at least one "Details" link
    cy.contains("a", "Details").first().should("be.visible").click();

    // URL should now be /providers/<some-provider-id>
    cy.url().should("match", /\/providers\/[a-z_-]+$/);

    // The provider detail page should render its breadcrumb back to Providers
    cy.contains("a", "Providers").should("be.visible");

    // Should show "Sync Controls" section heading
    cy.contains("Sync Controls").should("be.visible");
  });

  it("loads provider detail page directly by URL", () => {
    // Visit a known provider detail page directly
    cy.visit("/providers/strava");
    cy.url().should("include", "/providers/strava");

    // Should not redirect to login
    cy.contains("Sign in to view your health data").should("not.exist");

    // Should render the provider detail page content
    cy.contains("Sync Controls").should("be.visible");
    cy.contains("a", "Providers").should("be.visible");
  });
});
