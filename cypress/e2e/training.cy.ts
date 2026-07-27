describe("Training Page", () => {
  beforeEach(() => {
    cy.login();
  });

  afterEach(() => {
    cy.cleanTestData();
  });

  it("loads without errors", () => {
    cy.visit("/training");
    cy.url().should("include", "/training");
    cy.contains("Something went wrong").should("not.exist");
  });

  it("renders section headings", () => {
    cy.visit("/training");
    cy.contains("Training Calendar").should("be.visible");
    cy.contains("Fitness / Fatigue / Form").should("be.visible");
    cy.contains("Volume & Zones").should("be.visible");
  });

  it("renders sub-tab navigation", () => {
    cy.visit("/training");
    cy.get('nav[aria-label="Section navigation"]').within(() => {
      for (const tab of ["Overview", "Endurance", "Strength", "Hiking", "Recovery"]) {
        cy.contains("a", tab).should("be.visible");
      }
    });
  });

  for (const viewportWidth of [320, 390]) {
    it(`keeps every subsection reachable without horizontal scrolling at ${viewportWidth}px`, () => {
      cy.viewport(viewportWidth, 800);
      cy.visit("/training");

      cy.get('nav[aria-label="Section navigation"]')
        .should(($navigation) => {
          const navigation = $navigation[0];
          expect(navigation.scrollWidth).to.be.at.most(navigation.clientWidth);
        })
        .find("a")
        .should("have.length", 8)
        .each(($link) =>
          cy
            .wrap($link)
            .should("be.visible")
            .then(($visibleLink) => {
              const bounds = $visibleLink[0].getBoundingClientRect();
              expect(bounds.left).to.be.at.least(0);
              expect(bounds.right).to.be.at.most(viewportWidth);
            }),
        );

      cy.document().should((document) => {
        expect(document.documentElement.scrollWidth).to.be.at.most(viewportWidth);
      });

      cy.get('nav[aria-label="Section navigation"] a').first().focus();
      for (let tabIndex = 1; tabIndex < 8; tabIndex += 1) {
        cy.press(Cypress.Keyboard.Keys.TAB);
      }
      cy.focused().should("have.text", "Recovery");
      cy.press(Cypress.Keyboard.Keys.ENTER);
      cy.url().should("include", "/training/recovery");
    });
  }

  it("navigates to sub-tabs without errors", () => {
    const subtabs = [
      { label: "Endurance", path: "/training/endurance" },
      { label: "Strength", path: "/training/strength" },
      { label: "Hiking", path: "/training/hiking" },
      { label: "Recovery", path: "/training/recovery" },
    ];
    for (const { label, path } of subtabs) {
      cy.visit(path);
      cy.url().should("include", path);
      cy.contains(label).should("be.visible");
      cy.contains("Something went wrong").should("not.exist");
    }
  });

  it("weeklyVolume API returns valid data", () => {
    cy.request({
      url: "/api/trpc/training.weeklyVolume?input=%7B%22json%22%3A%7B%22days%22%3A90%7D%7D",
      failOnStatusCode: false,
    }).then((res) => {
      expect(res.status).to.eq(200);
      const body = res.body;
      expect(body).to.have.property("result");
      expect(body.result).to.have.property("data");
      const rows = body.result.data;
      expect(rows).to.be.an("array");
      // Verify hours is always a number (not a string) if rows exist
      for (const row of rows) {
        if (row.hours !== undefined) {
          expect(row.hours).to.be.a("number");
        }
      }
    });
  });
});
