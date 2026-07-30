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
      cy.contains("Sign in to Dofek").should("not.exist");
    });
  }

  it("keeps small-screen navigation bounded without displacing page content", () => {
    cy.viewport(390, 844);
    cy.visit("/dashboard");

    cy.get("main").then(($main) => {
      const initialMainTop = $main[0].getBoundingClientRect().top;

      cy.window().then((window) => {
        const initialScrollY = window.scrollY;

        cy.get('button[aria-label="Toggle navigation menu"]').click({
          scrollBehavior: false,
        });
        cy.get('[role="dialog"][aria-modal="true"]')
          .should("be.visible")
          .and("have.attr", "aria-labelledby");
        cy.get('nav[aria-label="Mobile"]').should("be.visible");
        cy.window().its("scrollY").should("equal", initialScrollY);
        cy.get("main").should(($openedMain) => {
          expect($openedMain[0].getBoundingClientRect().top).to.be.closeTo(initialMainTop, 1);
        });
      });
    });

    cy.focused().should("have.attr", "href", "/dashboard");
    cy.get("body").type("{esc}");
    cy.get('[role="dialog"]').should("not.exist");
    cy.get('button[aria-label="Toggle navigation menu"]').should("be.focused");

    cy.viewport(768, 1024);
    cy.get('button[aria-label="Toggle navigation menu"]').click();
    cy.get('[role="dialog"]').should("be.visible");

    cy.viewport(1024, 768);
    cy.get('[role="dialog"]').should("not.exist");
    cy.get('aside[aria-label="Primary navigation"]').should("be.visible");
  });
});
