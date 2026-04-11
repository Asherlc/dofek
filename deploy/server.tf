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

  provisioner "remote-exec" {
    inline = [
      "cd /opt/dofek",
      "test -f .env.deploy || printf 'IMAGE_TAG=latest\\n' > .env.deploy",
      "test -s .env.prod || { echo 'ERROR: .env.prod is missing or empty. Run secret-sync first.' >&2; exit 1; }",
      "docker compose --env-file .env.prod --env-file .env.deploy -f docker-compose.deploy.yml pull --ignore-pull-failures db redis collector ota databasus traefik portainer netdata",
      "docker compose --env-file .env.prod --env-file .env.deploy -f docker-compose.deploy.yml up -d db redis collector ota databasus traefik portainer netdata",
    ]
  }
}
