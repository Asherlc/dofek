terraform {
  cloud {
    organization = "dofek"
    workspaces {
      name = "dofek"
    }
  }
  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.49"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
    postgresql = {
      source  = "cyrilgdn/postgresql"
      version = "~> 1.25"
    }
  }
}

provider "hcloud" {
  token = var.hcloud_token
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

provider "postgresql" {
  host     = "127.0.0.1"
  port     = 5432
  database = "health"
  username = "health"
  password = var.postgres_password
  sslmode  = "disable"
}
