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

resource "hcloud_volume" "dofek_staging_data" {
  count = var.staging_data_volume_size_gb > 0 ? 1 : 0

  name      = var.staging_data_volume_name
  size      = var.staging_data_volume_size_gb
  server_id = hcloud_server.dofek_staging.id
  format    = "ext4"
  automount = true
}

resource "terraform_data" "staging_data_volume_mount_alias" {
  count = var.staging_data_volume_size_gb > 0 ? 1 : 0

  triggers_replace = [
    "volume-mount-alias-v5",
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
      "mkdir -p /mnt/dofek-data/postgres /mnt/dofek-data/clickhouse /mnt/dofek-data/databasus /mnt/dofek-data/cloudbeaver /mnt/dofek-data/redis /mnt/dofek-data/peerdb-catalog /mnt/dofek-data/peerdb-minio",
      "source_path=$(docker volume inspect -f '{{ .Mountpoint }}' dofek-staging_redis_data 2>/dev/null || true); if [ -n \"$source_path\" ] && [ -d \"$source_path\" ] && [ -z \"$(find /mnt/dofek-data/redis -mindepth 1 -print -quit)\" ] && [ -n \"$(find \"$source_path\" -mindepth 1 -print -quit)\" ]; then cp -a \"$source_path\"/. /mnt/dofek-data/redis/; fi",
    ]
  }
}

# NOTE: The otel-collector config is no longer synced from Terraform. It is a
# Docker Swarm config object (`otel_collector_config` in deploy/stack.yml,
# sourced from deploy/otel-collector-config.yaml) that `docker stack deploy`
# uploads into the swarm on every deploy — identical on every host (staging,
# OCI) with no host file. Swarm config objects are immutable, so on a content
# change bump the config key's version suffix (same as the clickhouse and
# netdata_db_limits_v2 configs).

resource "terraform_data" "staging_cloudbeaver_datasources_sync" {
  count = var.staging_data_volume_size_gb > 0 ? 1 : 0

  triggers_replace = [
    filesha256("${path.module}/cloudbeaver-data-sources.json"),
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
      "mkdir -p /mnt/dofek-data/cloudbeaver/GlobalConfiguration/.dbeaver",
    ]
  }

  provisioner "file" {
    source      = "${path.module}/cloudbeaver-data-sources.json"
    destination = "/mnt/dofek-data/cloudbeaver/GlobalConfiguration/.dbeaver/data-sources.json"
  }

  depends_on = [terraform_data.staging_data_volume_mount_alias]
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
