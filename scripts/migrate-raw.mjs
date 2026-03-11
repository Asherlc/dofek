// Run migrations by applying SQL files directly (no drizzle-kit needed).
// Usage: node scripts/migrate-raw.mjs
import fs from "node:fs";
import path from "node:path";
import pg from "postgres";

const sql = pg(process.env.DATABASE_URL);

// Create schema if needed
await sql`CREATE SCHEMA IF NOT EXISTS health`;
await sql`CREATE SCHEMA IF NOT EXISTS drizzle`;

// Create migrations tracking table
await sql`CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
  id SERIAL PRIMARY KEY,
  hash TEXT NOT NULL,
  created_at BIGINT
)`;

// Get list of migration files
const migrationsDir = path.resolve(import.meta.dirname, "../drizzle");
const files = fs
  .readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

// Get already applied migrations
const applied = await sql`SELECT hash FROM drizzle.__drizzle_migrations`;
const appliedSet = new Set(applied.map((r) => r.hash));

let count = 0;
for (const file of files) {
  if (appliedSet.has(file)) {
    continue;
  }
  console.log("Applying:", file);
  const content = fs.readFileSync(path.join(migrationsDir, file), "utf-8");
  await sql.unsafe(content);
  await sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${file}, ${Date.now()})`;
  count++;
}

console.log(`Done: ${count} migrations applied (${files.length - count} already applied)`);
await sql.end();
