terraform {
  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.49"
    }
    dokploy = {
      source  = "ahmedali6/dokploy"
      version = "~> 0.5"
    }
  }
}
