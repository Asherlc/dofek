function setEmulatedSystemAppearance(features: Array<{ name: string; value: string }>): void {
  cy.then(() =>
    Cypress.automation("remote:debugger:protocol", {
      command: "Emulation.setEmulatedMedia",
      params: {
        features,
      },
    }),
  );
}

function emulateSystemAppearance(value: "dark" | "light"): void {
  setEmulatedSystemAppearance([{ name: "prefers-color-scheme", value }]);
}

function resetSystemAppearance(): void {
  setEmulatedSystemAppearance([]);
}

function stubPublicAuthRequests(): void {
  cy.intercept("GET", "/api/auth/me", { statusCode: 401, body: { error: "Unauthorized" } });
  cy.intercept("GET", "/api/auth/providers", {
    statusCode: 200,
    body: { identity: [], data: [], password: true },
  });
}

function expectDarkSystemAppearance(): void {
  cy.window().then((window) => {
    expect(window.matchMedia("(prefers-color-scheme: dark)").matches).to.equal(true);
    expect(getComputedStyle(window.document.documentElement).colorScheme).to.equal("light dark");
  });
}

describe("System dark appearance", () => {
  before(function skipBrowsersWithoutCdpMediaEmulation() {
    if (Cypress.browser.family !== "chromium") {
      this.skip();
    }
  });

  beforeEach(() => {
    emulateSystemAppearance("dark");
    stubPublicAuthRequests();
  });

  afterEach(() => {
    resetSystemAppearance();
  });

  it("uses the dark semantic palette on the public landing page", () => {
    cy.visit("/");
    expectDarkSystemAppearance();
    cy.get("body").should("have.css", "background-color", "rgb(12, 20, 16)");
    cy.get("h1").should("have.css", "color", "rgb(232, 240, 234)");
    cy.contains("a", "Get started")
      .first()
      .should("have.css", "background-color", "rgb(116, 198, 157)")
      .and("have.css", "color", "rgb(12, 20, 16)");
  });

  it("uses dark page and surface colors on the login page", () => {
    cy.visit("/login");
    expectDarkSystemAppearance();
    cy.get("body").should("have.css", "background-color", "rgb(12, 20, 16)");
    cy.contains("h1", "Sign in to Dofek")
      .parent()
      .should("have.css", "background-color", "rgb(25, 38, 30)");
  });

  it("preserves the light palette on public and authentication surfaces", () => {
    emulateSystemAppearance("light");
    cy.visit("/");
    cy.window().then((window) => {
      expect(window.matchMedia("(prefers-color-scheme: dark)").matches).to.equal(false);
    });
    cy.get("body").should("have.css", "background-color", "rgb(238, 243, 237)");
    cy.get("h1").should("have.css", "color", "rgb(26, 46, 26)");
    cy.contains("a", "Get started")
      .first()
      .should("have.css", "background-color", "rgb(45, 122, 86)")
      .and("have.css", "color", "rgb(255, 255, 255)");

    cy.visit("/login");
    cy.window().then((window) => {
      expect(window.matchMedia("(prefers-color-scheme: dark)").matches).to.equal(false);
    });
    cy.get("body").should("have.css", "background-color", "rgb(238, 243, 237)");
    cy.contains("h1", "Sign in to Dofek")
      .parent()
      .should("have.css", "background-color", "rgb(245, 249, 245)");
  });
});
