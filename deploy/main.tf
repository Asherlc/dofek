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
    b2 = {
      source  = "Backblaze/b2"
      version = "0.14.1"
    }
    infisical = {
      source  = "infisical/infisical"
      version = "0.20.12"
    }
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

# Auth: B2_APPLICATION_KEY_ID / B2_APPLICATION_KEY on the runner.
# HCP workspace dofek/dofek is execution_mode=local; deploy-terraform.yml supplies env.
# Provider docs: https://registry.terraform.io/providers/Backblaze/b2/0.14.1/docs
provider "b2" {}

# Auth: Infisical OIDC via INFISICAL_AUTH_METHOD=oidc, INFISICAL_MACHINE_IDENTITY_ID,
# INFISICAL_AUTH_JWT (GitHub Actions OIDC JWT minted immediately before apply).
# Provider docs: https://registry.terraform.io/providers/infisical/infisical/0.20.12/docs
# GitHub OIDC: https://infisical.com/docs/documentation/platform/identities/oidc-auth/github
provider "infisical" {}
