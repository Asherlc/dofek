import { TEST_USER_ID } from "../support/test-user";

const VIEWPORT_WIDTHS = [320, 390] as const;
const ROOT_FONT_SIZES = [16, 32] as const;
const LIFE_EVENT_ID = "e2e00000-0000-4000-8000-000000002187";

function setRootFontSize(rootFontSize: number): void {
  cy.document().then((document) => {
    document.documentElement.style.fontSize = `${rootFontSize}px`;
  });
}

function expectInsideViewport(viewportWidth: number): (elements: JQuery<HTMLElement>) => void {
  return (elements) => {
    elements.each((_index, element) => {
      const bounds = element.getBoundingClientRect();
      expect(bounds.left, `${element.textContent} left edge`).to.be.at.least(0);
      expect(bounds.right, `${element.textContent} right edge`).to.be.at.most(viewportWidth);
    });
  };
}

function expectNoHorizontalOverflow(): void {
  cy.document().should((document) => {
    expect(document.documentElement.scrollWidth).to.be.at.most(
      document.documentElement.clientWidth,
    );
  });
}

describe("Responsive decision controls", () => {
  beforeEach(() => {
    cy.login();
  });

  afterEach(() => {
    cy.cleanTestData();
  });

  for (const viewportWidth of VIEWPORT_WIDTHS) {
    for (const rootFontSize of ROOT_FONT_SIZES) {
      it(`keeps Correlation controls visible at ${viewportWidth}px with ${rootFontSize}px root text`, () => {
        cy.intercept("POST", /\/api\/trpc\/.*correlation\.metrics/).as("correlationMetrics");
        cy.viewport(viewportWidth, 1200);
        cy.visit("/correlation");
        cy.wait("@correlationMetrics");
        cy.contains("Correlation Explorer").should("be.visible");
        setRootFontSize(rootFontSize);

        cy.get("main select")
          .should("have.length", 2)
          .should("be.visible")
          .and(expectInsideViewport(viewportWidth));

        cy.contains("button", "Same day")
          .parent()
          .find("button")
          .should("have.length", 4)
          .should("be.visible")
          .and(expectInsideViewport(viewportWidth));

        cy.contains("a", "Start experiment with Heart Rate Variability")
          .should("be.visible")
          .and(expectInsideViewport(viewportWidth));
        expectNoHorizontalOverflow();
      });

      it(`keeps selected life-event controls visible at ${viewportWidth}px with ${rootFontSize}px root text`, () => {
        cy.intercept("POST", /\/api\/trpc\/.*lifeEvents\.list/).as("lifeEvents");
        cy.intercept("POST", /\/api\/trpc\/.*lifeEvents\.analyze/).as("lifeEventAnalysis");
        cy.task("runQuery", {
          query: `
            INSERT INTO fitness.life_events (
              id, label, user_id, started_at, ended_at, category, ongoing, notes
            )
            VALUES (
              '${LIFE_EVENT_ID}',
              'Responsive control check',
              '${TEST_USER_ID}',
              '2026-07-20',
              '2026-07-27',
              'lifestyle',
              false,
              'Large text'
            )
            ON CONFLICT (id) DO UPDATE SET
              label = EXCLUDED.label,
              user_id = EXCLUDED.user_id,
              started_at = EXCLUDED.started_at,
              ended_at = EXCLUDED.ended_at,
              category = EXCLUDED.category,
              ongoing = EXCLUDED.ongoing,
              notes = EXCLUDED.notes
          `,
        });

        cy.viewport(viewportWidth, 1200);
        cy.visit("/tracking");
        cy.wait("@lifeEvents");
        cy.contains("button", "Responsive control check").click();
        cy.wait("@lifeEventAnalysis");
        cy.contains("button", "Delete").should("be.visible");
        setRootFontSize(rootFontSize);

        cy.contains("h3", "Responsive control check")
          .closest(".card")
          .within(() => {
            cy.contains("button", "14d")
              .parent()
              .find("button")
              .should("have.length", 4)
              .should("be.visible")
              .and(expectInsideViewport(viewportWidth));
            cy.contains("button", "Delete")
              .should("be.visible")
              .and(expectInsideViewport(viewportWidth));
          });
        expectNoHorizontalOverflow();
      });
    }
  }
});
