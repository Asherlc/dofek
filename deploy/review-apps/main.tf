terraform {
  cloud {
    organization = "dofek"
    workspaces {
      prefix = "dofek-review-"
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
