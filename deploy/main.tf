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

# Requires local execution mode in TF Cloud (set in workspace settings)
# and an SSH tunnel: ssh -f -N -L 5432:127.0.0.1:5432 root@<server>
provider "postgresql" {
  host     = "127.0.0.1"
  port     = 5432
  database = "health"
  username = "health"
  password = var.postgres_password
  sslmode  = "disable"
}
