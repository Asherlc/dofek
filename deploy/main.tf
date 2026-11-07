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
    # Writes KAFKA_TIERED_STORAGE_* into Infisical after Root-approved CI privilege.
    # Provider docs: https://registry.terraform.io/providers/infisical/infisical/0.20.12/docs
    infisical = {
      source  = "infisical/infisical"
      version = "0.20.12"
    }
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

# Auth: Infisical OIDC via INFISICAL_AUTH_METHOD=oidc, INFISICAL_MACHINE_IDENTITY_ID,
# INFISICAL_AUTH_JWT (GitHub Actions OIDC JWT minted immediately before apply).
# GitHub OIDC: https://infisical.com/docs/documentation/platform/identities/oidc-auth/github
provider "infisical" {}
