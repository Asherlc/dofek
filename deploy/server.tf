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

# Initialize Docker Swarm on the server. cloud-init also does this for fresh
# servers, but `user_data` is in `ignore_changes` on `hcloud_server.dofek`, so
# for the existing live server we apply it explicitly here. Idempotent.
resource "terraform_data" "swarm_init" {
  triggers_replace = ["swarm-v1"]

  connection {
    type        = "ssh"
    host        = hcloud_server.dofek.ipv4_address
    user        = "root"
    private_key = var.ssh_private_key
  }

  provisioner "remote-exec" {
    inline = [
      "docker info --format '{{.Swarm.LocalNodeState}}' | grep -q active || docker swarm init",
    ]
  }
}

# Run docuum for LRU image eviction. cloud-init starts it on fresh servers;
# this block covers the live server (whose user_data is in ignore_changes) and
# re-runs whenever the pinned version or threshold changes.
resource "terraform_data" "docuum" {
  triggers_replace = ["stephanmisc/docuum:0.27.0", "10 GB"]

  connection {
    type        = "ssh"
    host        = hcloud_server.dofek.ipv4_address
    user        = "root"
    private_key = var.ssh_private_key
  }

  provisioner "remote-exec" {
    inline = [
      "docker rm -f docuum 2>/dev/null || true",
      "docker run -d --name docuum --init --restart always -v /var/run/docker.sock:/var/run/docker.sock -v docuum:/root stephanmisc/docuum:0.27.0 --threshold '10 GB'",
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
