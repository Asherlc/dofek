locals {
  review_slug            = "pr-${var.pr_number}"
  review_host            = "${local.review_slug}.${var.review_base_domain}"
  review_server_name     = "dofek-${local.review_slug}"
  review_firewall_name   = "dofek-${local.review_slug}"
  front_door_source_cidr = "${var.front_door_ipv4}/32"
}

resource "hcloud_firewall" "review" {
  name = local.review_firewall_name

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "3000"
    source_ips = [local.front_door_source_cidr]
  }
}

resource "hcloud_server" "review" {
  name         = local.review_server_name
  image        = "ubuntu-24.04"
  server_type  = var.server_type
  location     = var.location
  ssh_keys     = ["dofek-deploy"]
  firewall_ids = [hcloud_firewall.review.id]

  user_data = file("${path.module}/server/cloud-init.yml")

  labels = {
    app         = "dofek"
    environment = "review"
    pr          = tostring(var.pr_number)
    role        = "review-app"
  }
}
