# Manages the TimescaleDB extension version.
# CI connects via SSH tunnel (localhost:5432 → server:5432).

terraform {
  cloud {
    organization = "dofek"
    workspaces {
      name = "dofek-db"
    }
  }
  required_providers {
    postgresql = {
      source  = "cyrilgdn/postgresql"
      version = "~> 1.25"
    }
  }
}

variable "postgres_password" {
  type      = string
  sensitive = true
}

provider "postgresql" {
  host     = "127.0.0.1"
  port     = 5432
  database = "health"
  username = "health"
  password = var.postgres_password
  sslmode  = "disable"
}

resource "postgresql_extension" "timescaledb" {
  name = "timescaledb"
}
