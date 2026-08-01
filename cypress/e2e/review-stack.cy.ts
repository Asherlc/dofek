const reviewSessionId = "dev-session";

function trpcInput(input: Record<string, unknown>): string {
  return encodeURIComponent(JSON.stringify({ json: input }));
}

describe("Review stack canonical activity routes", () => {
  beforeEach(() => {
    // cy.login() creates the disposable Cypress test user. This smoke test
    // must use the deterministic review user created by the stack seed.
    cy.setCookie("session", reviewSessionId, { path: "/" });
  });

  it("opens the seeded activity list and resolves every listed canonical ID in detail", () => {
    cy.intercept("POST", "**/api/trpc/*calendar.weekList*").as("activityCalendar");
    cy.visit("/activities");
    cy.wait("@activityCalendar").its("response.statusCode").should("eq", 200);
    cy.url().should("include", "/activities");
    cy.contains("Activity log").should("be.visible");

    cy.get('a[href^="/activity/"]')
      .should("have.length.greaterThan", 0)
      .then(($links) => {
        const activities = [...$links].map((link) => ({
          detailPath: link.getAttribute("href"),
          label: link.textContent?.trim(),
        }));

        for (const activity of activities) {
          expect(activity.detailPath).to.match(/^\/activity\/[0-9a-f-]{36}$/);
          const activityId = activity.detailPath?.split("/").at(-1);
          expect(activityId).to.match(/^[0-9a-f-]{36}$/);

          cy.request(`/api/trpc/activity.byId?input=${trpcInput({ id: activityId })}`).then(
            (response) => {
              expect(response.status).to.equal(200);
              expect(response.body.result.data.id).to.equal(activityId);
            },
          );
        }

        const firstActivity = activities[0];
        if (!firstActivity?.detailPath) {
          throw new Error("The seeded activity list did not contain a detail route");
        }

        cy.visit(firstActivity.detailPath);
        cy.url().should("include", firstActivity.detailPath);
        cy.contains("Activity not found").should("not.exist");
        cy.contains("Dashboard").should("be.visible");
        expect(firstActivity.label).to.be.a("string").and.not.be.empty;
      });
  });
});
