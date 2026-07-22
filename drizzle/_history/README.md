# Archived Migration History

SQL files in this directory preserve immutable migrations that were applied to
an existing database but were later compacted into `drizzle/0000_baseline.sql`.
They are integrity records, not executable migrations.

`src/db/postgres-migrator.ts` hashes these files when reconciling legacy rows in
`drizzle.__drizzle_migrations`. It never passes them to Drizzle's migration
runner. This separation matters because Drizzle applies missing SQL files from
the active migrations directory; replaying a compacted migration after the
current baseline can corrupt a fresh bootstrap. See the official
[Drizzle migration process](https://orm.drizzle.team/docs/drizzle-kit-migrate).

- Never edit or delete an archived SQL file after it has been applied.
- Keep archived files byte-for-byte identical to the original migration.
- Put new forward migrations in `drizzle/` and record them in
  `drizzle/meta/_journal.json`.
- Move an applied migration here only when the baseline already contains its
  final schema effect and the executable migration is no longer safe to replay.
