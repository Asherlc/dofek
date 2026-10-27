describe("Login page", () => {
  it("shows the login page with sign-in heading", () => {
    cy.visit("/login");
    cy.contains("h1", "Sign in to Dofek").should("be.visible");
    cy.contains("View and manage your health data.").should("be.visible");
  });

  it("redirects unauthenticated users to /login", () => {
    cy.visit("/dashboard");
    cy.url().should("include", "/login");
  });
});
