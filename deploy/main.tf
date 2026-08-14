terraform {
  required_version = ">= 1.6"
  cloud {
    organization = "dofek"
    workspaces {
      name = "dofek"
    }
  }
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}
