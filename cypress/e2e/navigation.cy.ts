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
    { path: "/nutrition", label: "Nutrition" },
    { path: "/providers", label: "Providers" },
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
