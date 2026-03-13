import { defineConfig } from "cypress";
import postgres from "postgres";

const E2E_DB_URL = process.env.E2E_DATABASE_URL ?? "postgres://health:health@localhost:5436/health";
const E2E_SERVER_URL = process.env.E2E_SERVER_URL ?? "http://localhost:3100";

export default defineConfig({
  e2e: {
    baseUrl: E2E_SERVER_URL,
    specPattern: "cypress/e2e/**/*.cy.ts",
    supportFile: "cypress/support/e2e.ts",
    // No need for complex retries in e2e — fail fast
    retries: { runMode: 1, openMode: 0 },
    defaultCommandTimeout: 10000,
    video: false,
    setupNodeEvents(on) {
      const sql = postgres(E2E_DB_URL, { max: 2 });

      on("task", {
        async seedTestUser({ userId, name, email }) {
          await sql`
            INSERT INTO fitness.user_profile (id, name, email)
            VALUES (${userId}, ${name}, ${email})
            ON CONFLICT (id) DO NOTHING
          `;
          return null;
        },

        async createSession({ sessionId, userId }) {
          const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
          await sql`
            INSERT INTO fitness.session (id, user_id, expires_at)
            VALUES (${sessionId}, ${userId}, ${expiresAt.toISOString()})
            ON CONFLICT (id) DO NOTHING
          `;
          return null;
        },

        async cleanTestData({ userId }) {
          // Delete in dependency order
          await sql`DELETE FROM fitness.session WHERE user_id = ${userId}`;
          await sql`DELETE FROM fitness.user_profile WHERE id = ${userId}`;
          return null;
        },

        async runQuery({ query }) {
          const rows = await sql.unsafe(query);
          return rows;
        },
      });

      on("after:run", async () => {
        await sql.end();
      });
    },
  },
});
