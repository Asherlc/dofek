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

  # ssh_keys, user_data, and image are immutable (ForceNew). Ignore changes
  # to prevent Terraform from destroying the running server when cloud-init,
  # key config, or base image drifts. To reprovision, taint the resource.
  lifecycle {
    ignore_changes = [ssh_keys, user_data, image]
  }
}

resource "hcloud_volume" "dofek_data" {
  count = var.data_volume_size_gb > 0 ? 1 : 0

  name      = var.data_volume_name
  size      = var.data_volume_size_gb
  server_id = hcloud_server.dofek.id
  format    = "ext4"
  automount = true
}

# Copy compose + OTel config and start infra services.
# Re-runs whenever the compose file or OTel config changes.
resource "terraform_data" "deploy_compose" {
  triggers_replace = [
    filesha256("${path.module}/docker-compose.deploy.yml"),
    filesha256("${path.module}/otel-collector-config.yaml"),
    filesha256("${path.module}/server/run-compose-with-infisical.sh"),
  ]

  connection {
    type        = "ssh"
    host        = hcloud_server.dofek.ipv4_address
    user        = "root"
    private_key = var.ssh_private_key
  }

  provisioner "file" {
    source      = "${path.module}/docker-compose.deploy.yml"
    destination = "/opt/dofek/docker-compose.deploy.yml"
  }

  provisioner "file" {
    source      = "${path.module}/otel-collector-config.yaml"
    destination = "/opt/dofek/otel-collector-config.yaml"
  }

  provisioner "file" {
    source      = "${path.module}/server/run-compose-with-infisical.sh"
    destination = "/opt/dofek/run-compose-with-infisical.sh"
  }

  provisioner "remote-exec" {
    inline = [
      "cd /opt/dofek",
      "chmod 700 /opt/dofek/run-compose-with-infisical.sh",
      "test -f .env.deploy || printf 'IMAGE_TAG=latest\\n' > .env.deploy",
      "test -n \"${var.infisical_token}\" || { echo 'ERROR: infisical_token is required' >&2; exit 1; }",
      "REQUIRED_INFISICAL_VARS='CLOUDFLARE_API_TOKEN POSTGRES_PASSWORD PGADMIN_DEFAULT_EMAIL PGADMIN_DEFAULT_PASSWORD R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY OTA_JWT_SECRET OTA_PRIVATE_KEY_B64 OTA_PUBLIC_KEY_B64' INFISICAL_TOKEN='${var.infisical_token}' /opt/dofek/run-compose-with-infisical.sh compose pull --ignore-pull-failures db redis collector ota databasus pgadmin traefik portainer netdata",
      "REQUIRED_INFISICAL_VARS='CLOUDFLARE_API_TOKEN POSTGRES_PASSWORD PGADMIN_DEFAULT_EMAIL PGADMIN_DEFAULT_PASSWORD R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY OTA_JWT_SECRET OTA_PRIVATE_KEY_B64 OTA_PUBLIC_KEY_B64' INFISICAL_TOKEN='${var.infisical_token}' /opt/dofek/run-compose-with-infisical.sh compose up -d db redis collector ota databasus pgadmin traefik portainer netdata",
    ]
  }
}
