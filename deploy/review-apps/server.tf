locals {
  review_slug              = "pr-${var.pr_number}"
  review_host              = "${local.review_slug}.${var.review_base_domain}"
  review_server_name       = "dofek-${local.review_slug}"
  review_firewall_name     = "dofek-${local.review_slug}"
  review_route_file_name   = "review-app-${local.review_slug}.yml"
  review_route_remote_path = "/opt/dofek/traefik-dynamic/${local.review_route_file_name}"
  front_door_source_cidr   = "${var.front_door_ipv4}/32"
  traefik_router_name      = "review-app-${local.review_slug}"
  traefik_dynamic_config   = <<-EOT
    http:
      routers:
        ${local.traefik_router_name}:
          entryPoints:
            - websecure
          rule: Host(`${local.review_host}`)
          service: ${local.traefik_router_name}
          tls:
            certResolver: le

      services:
        ${local.traefik_router_name}:
          loadBalancer:
            servers:
              - url: http://${hcloud_server.review.ipv4_address}:3000
    EOT
}

resource "hcloud_ssh_key" "review" {
  name       = "${local.review_server_name}-deploy"
  public_key = var.ssh_public_key
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
  ssh_keys     = [hcloud_ssh_key.review.id]
  firewall_ids = [hcloud_firewall.review.id]

  user_data = file("${path.module}/server/cloud-init.yml")

  labels = {
    app         = "dofek"
    environment = "review"
    pr          = tostring(var.pr_number)
    role        = "review-app"
  }
}

resource "terraform_data" "front_door_route" {
  triggers_replace = [
    local.review_host,
    hcloud_server.review.ipv4_address,
    local.traefik_dynamic_config,
  ]

  connection {
    type        = "ssh"
    host        = var.front_door_host
    user        = "root"
    private_key = var.ssh_private_key
  }

  provisioner "remote-exec" {
    inline = [
      "mkdir -p /opt/dofek/traefik-dynamic",
      <<-EOC
      cat <<'EOF' > ${local.review_route_remote_path}
      ${local.traefik_dynamic_config}
      EOF
      EOC
    ]
  }

  depends_on = [hcloud_server.review]
}
