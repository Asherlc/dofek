describe("Navigation", () => {
  beforeEach(() => {
    cy.login();
  });

  afterEach(() => {
    cy.cleanTestData();
  });

  const routes = [
    { path: "/dashboard", label: "Dashboard" },
    { path: "/training", label: "Training" },
    { path: "/sleep", label: "Sleep" },
    { path: "/nutrition", label: "Nutrition" },
    { path: "/body", label: "Body" },
    { path: "/correlation", label: "Correlation" },
    { path: "/tracking", label: "Tracking" },
    { path: "/settings", label: "Settings" },
  ];

  for (const { path, label } of routes) {
    it(`navigates to ${label} (${path}) without errors`, () => {
      cy.visit(path);
      cy.url().should("include", path);
      // Should not redirect to login
      cy.contains("Sign in to view your health data").should("not.exist");
    });
  }
});
