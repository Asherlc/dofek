import { createTaggedQueryClient } from "../src/db/tagged-query-client.ts";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL not set");
    process.exit(1);
  }
  const sql = createTaggedQueryClient(databaseUrl);
  const result =
    await sql`SELECT refresh_token FROM fitness.oauth_token WHERE provider_id = 'whoop' LIMIT 1`;
  const token = result[0]?.refresh_token;
  console.log(String(token));
  await sql.end();
  process.exit(0);
}

main();
