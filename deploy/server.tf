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

resource "hcloud_server" "dofek_staging" {
  name         = "dofek-staging"
  image        = "ubuntu-24.04"
  server_type  = "cax11"
  location     = "nbg1"
  ssh_keys     = [hcloud_ssh_key.default.id]
  firewall_ids = [hcloud_firewall.dofek.id]

  user_data = templatefile("${path.module}/server/cloud-init.yml", {
    otel_collector_content = file("${path.module}/otel-collector-config.yaml")
  })

  lifecycle {
    ignore_changes = [ssh_keys, user_data, image]
  }
}

resource "terraform_data" "app_directories_sync" {
  triggers_replace = [
    "app-directories-v1",
  ]

  connection {
    type        = "ssh"
    host        = hcloud_server.dofek.ipv4_address
    user        = "root"
    private_key = var.ssh_private_key
  }

  provisioner "remote-exec" {
    inline = [
      "mkdir -p /opt/dofek /opt/dofek/traefik-dynamic",
    ]
  }
}

resource "terraform_data" "staging_app_directories_sync" {
  triggers_replace = [
    "app-directories-v1",
  ]

  connection {
    type        = "ssh"
    host        = hcloud_server.dofek_staging.ipv4_address
    user        = "root"
    private_key = var.ssh_private_key
  }

  provisioner "remote-exec" {
    inline = [
      "mkdir -p /opt/dofek /opt/dofek/traefik-dynamic",
    ]
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

resource "hcloud_volume" "dofek_staging_data" {
  count = var.staging_data_volume_size_gb > 0 ? 1 : 0

  name      = var.staging_data_volume_name
  size      = var.staging_data_volume_size_gb
  server_id = hcloud_server.dofek_staging.id
  format    = "ext4"
  automount = true
}

# Keep a stable mount alias for services that bind-mount persistent data.
resource "terraform_data" "data_volume_mount_alias" {
  count = var.data_volume_size_gb > 0 ? 1 : 0

  triggers_replace = [
    "volume-mount-alias-v3",
    hcloud_volume.dofek_data[0].id,
  ]

  connection {
    type        = "ssh"
    host        = hcloud_server.dofek.ipv4_address
    user        = "root"
    private_key = var.ssh_private_key
  }

  provisioner "remote-exec" {
    inline = [
      "set -eu",
      "target=/mnt/HC_Volume_${hcloud_volume.dofek_data[0].id}",
      "if [ ! -d \"$target\" ]; then echo \"Expected mounted volume path missing: $target\" >&2; exit 1; fi",
      "ln -sfn \"$target\" /mnt/dofek-data",
      "mkdir -p /mnt/dofek-data/postgres /mnt/dofek-data/databasus /mnt/dofek-data/redis",
      "source_path=$(docker volume inspect -f '{{ .Mountpoint }}' dofek_databasus_data 2>/dev/null || true); if [ -n \"$source_path\" ] && [ -d \"$source_path\" ] && [ -z \"$(find /mnt/dofek-data/databasus -mindepth 1 -print -quit)\" ] && [ -n \"$(find \"$source_path\" -mindepth 1 -print -quit)\" ]; then cp -a \"$source_path\"/. /mnt/dofek-data/databasus/; fi",
      "source_path=$(docker volume inspect -f '{{ .Mountpoint }}' dofek_redis_data 2>/dev/null || true); if [ -n \"$source_path\" ] && [ -d \"$source_path\" ] && [ -z \"$(find /mnt/dofek-data/redis -mindepth 1 -print -quit)\" ] && [ -n \"$(find \"$source_path\" -mindepth 1 -print -quit)\" ]; then cp -a \"$source_path\"/. /mnt/dofek-data/redis/; fi",
    ]
  }
}

resource "terraform_data" "staging_data_volume_mount_alias" {
  count = var.staging_data_volume_size_gb > 0 ? 1 : 0

  triggers_replace = [
    "volume-mount-alias-v1",
    hcloud_volume.dofek_staging_data[0].id,
  ]

  connection {
    type        = "ssh"
    host        = hcloud_server.dofek_staging.ipv4_address
    user        = "root"
    private_key = var.ssh_private_key
  }

  provisioner "remote-exec" {
    inline = [
      "set -eu",
      "target=/mnt/HC_Volume_${hcloud_volume.dofek_staging_data[0].id}",
      "if [ ! -d \"$target\" ]; then echo \"Expected mounted volume path missing: $target\" >&2; exit 1; fi",
      "ln -sfn \"$target\" /mnt/dofek-data",
      "mkdir -p /mnt/dofek-data/postgres /mnt/dofek-data/databasus /mnt/dofek-data/redis",
      "source_path=$(docker volume inspect -f '{{ .Mountpoint }}' dofek-staging_redis_data 2>/dev/null || true); if [ -n \"$source_path\" ] && [ -d \"$source_path\" ] && [ -z \"$(find /mnt/dofek-data/redis -mindepth 1 -print -quit)\" ] && [ -n \"$(find \"$source_path\" -mindepth 1 -print -quit)\" ]; then cp -a \"$source_path\"/. /mnt/dofek-data/redis/; fi",
    ]
  }
}

# Sync otel-collector config to the server (bind-mounted into the collector
# service by stack.yml). Re-runs whenever the config changes.
resource "terraform_data" "otel_config_sync" {
  triggers_replace = [
    filesha256("${path.module}/otel-collector-config.yaml"),
  ]

  connection {
    type        = "ssh"
    host        = hcloud_server.dofek.ipv4_address
    user        = "root"
    private_key = var.ssh_private_key
  }

  provisioner "file" {
    source      = "${path.module}/otel-collector-config.yaml"
    destination = "/opt/dofek/otel-collector-config.yaml"
  }

  # If the stack is already deployed, force the collector to pick up the new config.
  provisioner "remote-exec" {
    inline = [
      "docker service ls --format '{{.Name}}' | grep -qx dofek_collector && docker service update --force dofek_collector || true",
    ]
  }
}

resource "terraform_data" "staging_otel_config_sync" {
  triggers_replace = [
    filesha256("${path.module}/otel-collector-config.yaml"),
  ]

  connection {
    type        = "ssh"
    host        = hcloud_server.dofek_staging.ipv4_address
    user        = "root"
    private_key = var.ssh_private_key
  }

  provisioner "file" {
    source      = "${path.module}/otel-collector-config.yaml"
    destination = "/opt/dofek/otel-collector-config.yaml"
  }

  provisioner "remote-exec" {
    inline = [
      "docker service ls --format '{{.Name}}' | grep -qx dofek-staging_collector && docker service update --force dofek-staging_collector || true",
    ]
  }
}

# Apply Redis kernel configuration to existing servers
resource "terraform_data" "redis_kernel_config" {
  triggers_replace = [
    "redis-overcommit-v1"
  ]

  connection {
    type        = "ssh"
    host        = hcloud_server.dofek.ipv4_address
    user        = "root"
    private_key = var.ssh_private_key
  }

  provisioner "remote-exec" {
    inline = [
      "sysctl -w vm.overcommit_memory=1",
      "sh -c 'echo \"vm.overcommit_memory=1\" > /etc/sysctl.d/99-redis.conf'"
    ]
  }
}

resource "terraform_data" "staging_redis_kernel_config" {
  triggers_replace = [
    "redis-overcommit-v1"
  ]

  connection {
    type        = "ssh"
    host        = hcloud_server.dofek_staging.ipv4_address
    user        = "root"
    private_key = var.ssh_private_key
  }

  provisioner "remote-exec" {
    inline = [
      "sysctl -w vm.overcommit_memory=1",
      "sh -c 'echo \"vm.overcommit_memory=1\" > /etc/sysctl.d/99-redis.conf'"
    ]
  }
}
