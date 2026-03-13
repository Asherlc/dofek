describe("Login page", () => {
  it("shows the login page with sign-in heading", () => {
    cy.visit("/login");
    cy.contains("Dofek").should("be.visible");
    cy.contains("Sign in to view your health data").should("be.visible");
  });

  it("redirects unauthenticated users to /login", () => {
    cy.visit("/dashboard");
    cy.url().should("include", "/login");
  });
});
