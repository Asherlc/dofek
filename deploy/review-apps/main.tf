terraform {
  cloud {
    organization = "dofek"
    workspaces {
      tags = ["review-app"]
    }
  }

  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.49"
    }
  }
}

provider "hcloud" {
  token = var.hcloud_token
}
