import { z } from "zod";

const TEST_USER_ID = "e2e00000-0000-4000-8000-000000000001";
const requestRowSchema = z.object({
  outbox_status: z.literal("pending"),
  status: z.literal("pending"),
});

describe("Account erasure", () => {
  beforeEach(() => {
    cy.login();
  });

  afterEach(() => {
    cy.cleanTestData();
  });

  it("accepts the irreversible request, revokes the session, and opens public status", () => {
    cy.visit("/settings");
    cy.contains('[role="tab"]', "Privacy/Export").click();
    cy.contains("button", "Delete account").click();
    cy.contains("label", 'Type "DELETE" to continue').find("input").type("DELETE");
    cy.contains("button", "Prepare account deletion").click();
    cy.contains("button", "Permanently delete my account").click();

    cy.url().should("include", "/account-deletion");
    cy.contains("h1", "Account deletion status").should("be.visible");

    cy.request({
      failOnStatusCode: false,
      url: "/api/auth/me",
    })
      .its("status")
      .should("eq", 401);

    cy.task("runQuery", {
      query: `
        SELECT request.status, outbox.status AS outbox_status
        FROM fitness.account_erasure_request AS request
        JOIN fitness.account_erasure_outbox AS outbox
          ON outbox.request_id = request.id
        WHERE request.user_id = '${TEST_USER_ID}'::uuid
      `,
    }).then((result) => {
      expect(z.array(requestRowSchema).parse(result)).to.deep.equal([
        { outbox_status: "pending", status: "pending" },
      ]);
    });
  });
});
