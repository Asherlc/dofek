const usableProviders = [
  { id: "apple_health", name: "Apple Health", authType: "file-import", importOnly: true },
];

function stubPublicLandingRequests(): void {
  cy.intercept("GET", "/api/auth/me", {
    statusCode: 401,
    body: { error: "Unauthorized" },
  });
  cy.intercept("GET", "/api/auth/providers", {
    statusCode: 200,
    body: { identity: [], data: [], password: true },
  });
  cy.intercept("POST", "/api/trpc/sync.usableProviders*", {
    statusCode: 200,
    body: [{ result: { data: usableProviders } }],
  }).as("usableProviders");
}

function expectWithinFirstViewport(text: string): void {
  cy.contains(text)
    .should("be.visible")
    .should(($element) => {
      const bottom = $element[0].getBoundingClientRect().bottom;
      expect(bottom, `${text} bottom edge`).to.be.at.most(667);
    });
}

describe("Landing page mobile hero", () => {
  beforeEach(() => {
    stubPublicLandingRequests();
  });

  it("shows the concrete recovery outcome in the first viewport", () => {
    cy.viewport(390, 667);
    cy.visit("/");
    cy.wait("@usableProviders");

    expectWithinFirstViewport("Example recovery picture");
    expectWithinFirstViewport("74%");
    expectWithinFirstViewport("Near baseline");
  });
});
