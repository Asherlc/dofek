const TEST_USER_ID = "e2e00000-0000-0000-0000-000000000001";

describe("Nutrition page", () => {
  beforeEach(() => {
    cy.login();
    // Ensure dofek provider exists for test food entries
    cy.task("runQuery", {
      query: `INSERT INTO fitness.provider (id, name) VALUES ('dofek', 'Dofek App') ON CONFLICT (id) DO NOTHING`,
    });
  });

  afterEach(() => {
    cy.task("runQuery", {
      query: `DELETE FROM fitness.food_entry WHERE user_id = '${TEST_USER_ID}'`,
    });
    cy.cleanTestData();
  });

  it("renders food entries that have null calories without crashing", () => {
    const today = new Date().toISOString().slice(0, 10);

    // Insert a food entry with calories and one without
    cy.task("runQuery", {
      query: `
        INSERT INTO fitness.food_entry (user_id, provider_id, date, food_name, meal, calories, protein_g)
        VALUES
          ('${TEST_USER_ID}', 'dofek', '${today}', 'Chicken breast', 'lunch', 350, 40),
          ('${TEST_USER_ID}', 'dofek', '${today}', 'Mystery food', 'dinner', NULL, NULL)
      `,
    });

    cy.visit("/nutrition");

    // Page should render both entries without a Zod parse error
    cy.contains("Chicken breast").should("be.visible");
    cy.contains("Mystery food").should("be.visible");

    // The entry with calories should show its value
    cy.contains("350 kcal").should("be.visible");
  });
});
