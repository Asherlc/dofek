import { REVIEW_SEED_SESSION_ID, REVIEW_SEED_USER_ID } from "../support/commands";

function trpcInput(input: Record<string, unknown>): string {
  return encodeURIComponent(JSON.stringify(input));
}

const canonicalActivityPath =
  /^\/activity\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

describe("Review stack canonical activity routes", () => {
  beforeEach(() => {
    // This smoke test uses the deterministic review user created by the stack seed.
    cy.setCookie("session", REVIEW_SEED_SESSION_ID, { path: "/" });
    cy.request("/api/auth/me").its("body.id").should("eq", REVIEW_SEED_USER_ID);
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
          const activityId = activity.detailPath?.match(canonicalActivityPath)?.[1];
          expect(activity.detailPath).to.match(canonicalActivityPath);
          if (!activityId) {
            throw new Error("The seeded activity list did not contain a canonical activity ID");
          }

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
