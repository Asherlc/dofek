describe("Dashboard", () => {
  beforeEach(() => {
    cy.login();
  });

  afterEach(() => {
    cy.cleanTestData();
  });

  it("loads the dashboard when authenticated", () => {
    cy.visit("/dashboard");
    cy.url().should("include", "/dashboard");
    // The dashboard should render without redirecting to login
    cy.contains("Sign in to view your health data").should("not.exist");
  });

  it("shows the user identity via /api/auth/me", () => {
    cy.request({ url: "/api/auth/me", failOnStatusCode: false }).then((res) => {
      expect(res.status).to.eq(200);
      expect(res.body).to.have.property("name", "E2E Test User");
      expect(res.body).to.have.property("email", "e2e@test.local");
    });
  });
});
