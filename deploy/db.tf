# CI opens an SSH tunnel (localhost:5432 → server:5432) before applying.

resource "postgresql_extension" "timescaledb" {
  name = "timescaledb"
}
