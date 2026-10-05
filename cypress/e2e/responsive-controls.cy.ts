const VIEWPORT_WIDTHS = [320, 390] as const;
const ROOT_FONT_SIZES = [16, 32] as const;

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
    }
  }
});
