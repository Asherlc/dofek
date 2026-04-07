# Hetzner server provisioned with Dokploy pre-installed.
# Replaces the old main.tf which installed raw Docker + Compose.

# The terraform block with required_providers is in providers.tf

variable "hcloud_token" {
  sensitive = true
}

variable "ssh_public_key" {
  description = "SSH public key for server access"
  type        = string
}

## variable "domain" is defined in dokploy.tf

variable "ssh_allowed_ips" {
  description = "CIDR blocks allowed to SSH"
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]
}

variable "data_volume_size_gb" {
  description = "Optional Hetzner block storage size in GB (0 = disabled)"
  type        = number
  default     = 0
}

variable "data_volume_name" {
  description = "Hetzner block storage volume name"
  type        = string
  default     = "dofek-data"
}

locals {
  data_volume_mountpoint = var.data_volume_size_gb > 0 ? "/mnt/HC_Volume_${var.data_volume_name}" : ""
}

provider "hcloud" {
  token = var.hcloud_token
}

resource "hcloud_ssh_key" "default" {
  name       = "dofek-deploy"
  public_key = var.ssh_public_key
}

resource "hcloud_firewall" "dofek" {
  name = "dofek"

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = var.ssh_allowed_ips
  }

  # HTTP/HTTPS for Traefik (Dokploy's reverse proxy)
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "80"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "443"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  # Dokploy dashboard (only during initial setup, then behind Traefik)
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "3000"
    source_ips = var.ssh_allowed_ips
  }
}

resource "hcloud_server" "dofek" {
  name         = "dofek-dokploy"
  image        = "ubuntu-24.04"
  server_type  = "cax11"
  location     = "nbg1"
  ssh_keys     = [hcloud_ssh_key.default.id]
  firewall_ids = [hcloud_firewall.dofek.id]

  user_data = templatefile("${path.module}/cloud-init.yml", {
    domain                 = var.domain
    otel_collector_content = file("${path.module}/otel-collector-config.yaml")
    db_data_path           = local.data_volume_mountpoint != "" ? "${local.data_volume_mountpoint}/postgres" : ""
    db_backup_path         = local.data_volume_mountpoint != "" ? "${local.data_volume_mountpoint}/backups" : ""
  })
}

resource "hcloud_volume" "dofek_data" {
  count = var.data_volume_size_gb > 0 ? 1 : 0

  name      = var.data_volume_name
  size      = var.data_volume_size_gb
  server_id = hcloud_server.dofek.id
  format    = "ext4"
  automount = true
}

output "server_ip" {
  value = hcloud_server.dofek.ipv4_address
}

output "server_ipv6" {
  value = hcloud_server.dofek.ipv6_address
}

output "dokploy_url" {
  description = "Dokploy dashboard URL (use this for initial setup, then configure a domain)"
  value       = "http://${hcloud_server.dofek.ipv4_address}:3000"
}
