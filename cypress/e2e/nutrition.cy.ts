const TEST_USER_ID = "e2e00000-0000-0000-0000-000000000001";

describe("Nutrition page", () => {
  beforeEach(() => {
    cy.login();
    // Ensure dofek provider exists for test food entries
    cy.task("runQuery", {
      query: `INSERT INTO fitness.provider (id, name, user_id)
              VALUES ('dofek', 'Dofek App', '${TEST_USER_ID}')
              ON CONFLICT (id) DO NOTHING`,
    });
  });

  afterEach(() => {
    cy.task("runQuery", {
      query: `DELETE FROM fitness.food_entry WHERE user_id = '${TEST_USER_ID}'`,
    });
    cy.task("runQuery", {
      query: `DELETE FROM fitness.provider WHERE id = 'dofek' AND user_id = '${TEST_USER_ID}'`,
    });
    cy.cleanTestData();
  });

  it("renders food entries that have null calories without crashing", () => {
    const today = new Date().toISOString().slice(0, 10);

    // Insert food entries with nutrition_data (one with calories, one without)
    cy.task("runQuery", {
      query: `
        WITH nd1 AS (
          INSERT INTO fitness.nutrition_data (calories, protein_g)
          VALUES (350, 40)
          RETURNING id
        ),
        nd2 AS (
          INSERT INTO fitness.nutrition_data (calories, protein_g)
          VALUES (NULL, NULL)
          RETURNING id
        )
        INSERT INTO fitness.food_entry (user_id, provider_id, date, food_name, meal, nutrition_data_id)
        VALUES
          ('${TEST_USER_ID}', 'dofek', '${today}', 'Chicken breast', 'lunch', (SELECT id FROM nd1)),
          ('${TEST_USER_ID}', 'dofek', '${today}', 'Mystery food', 'dinner', (SELECT id FROM nd2))
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
