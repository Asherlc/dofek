# Update server-side config files that aren't managed by Dokploy.
# Currently just the OTEL collector config (bind-mounted by the infra compose stack).
# Run: terraform apply -target=null_resource.update_otel_config

variable "server_ip" {
  description = "Server IP for SSH-based config updates"
  type        = string
  default     = ""
}

resource "null_resource" "update_otel_config" {
  count = var.server_ip != "" ? 1 : 0

  triggers = {
    otel_hash = filemd5("${path.module}/otel-collector-config.yaml")
  }

  connection {
    type  = "ssh"
    host  = var.server_ip
    user  = "root"
    agent = true
  }

  provisioner "file" {
    source      = "${path.module}/otel-collector-config.yaml"
    destination = "/opt/dofek/otel-collector-config.yaml"
  }

  # Restart the collector to pick up the new config.
  # The compose stack's collector service bind-mounts this file.
  provisioner "remote-exec" {
    inline = [
      "docker service ls --filter name=dofek-infra --format '{{.Name}}' | grep collector | xargs -r docker service update --force"
    ]
  }
}
