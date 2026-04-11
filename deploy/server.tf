locals {
  data_volume_mountpoint = var.data_volume_size_gb > 0 ? "/mnt/HC_Volume_${var.data_volume_name}" : ""
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
}

resource "hcloud_server" "dofek" {
  name         = "dofek"
  image        = "ubuntu-24.04"
  server_type  = "cax11"
  location     = "nbg1"
  ssh_keys     = [hcloud_ssh_key.default.id]
  firewall_ids = [hcloud_firewall.dofek.id]

  user_data = templatefile("${path.module}/server/cloud-init.yml", {
    otel_collector_content = file("${path.module}/otel-collector-config.yaml")
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
