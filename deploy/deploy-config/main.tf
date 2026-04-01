variable "server_ip" {
  description = "Server IP address to deploy config to"
  type        = string
}

resource "null_resource" "deploy_config" {
  triggers = {
    compose_hash                 = filemd5("${path.module}/../docker-compose.yml")
    hotfix_compose_hash          = filemd5("${path.module}/../docker-compose.hotfix.yml")
    caddy_hash                   = filemd5("${path.module}/../Caddyfile")
    collector_hash               = filemd5("${path.module}/../otel-collector-config.yaml")
    root_index_patch_hash        = filemd5("${path.module}/../../src/index.ts")
    provider_index_patch_hash    = filemd5("${path.module}/../../src/providers/index.ts")
    process_sync_patch_hash      = filemd5("${path.module}/../../src/jobs/process-sync-job.ts")
    process_scheduled_patch_hash = filemd5("${path.module}/../../src/jobs/process-scheduled-sync-job.ts")
    training_export_patch_hash   = filemd5("${path.module}/../../src/jobs/process-training-export-job.ts")
  }

  connection {
    type  = "ssh"
    host  = var.server_ip
    user  = "root"
    agent = true
  }

  provisioner "remote-exec" {
    inline = [
      "mkdir -p /opt/dofek/patches"
    ]
  }

  provisioner "file" {
    source      = "${path.module}/../docker-compose.yml"
    destination = "/opt/dofek/docker-compose.yml"
  }

  provisioner "file" {
    source      = "${path.module}/../docker-compose.hotfix.yml"
    destination = "/opt/dofek/docker-compose.hotfix.yml"
  }

  provisioner "file" {
    source      = "${path.module}/../Caddyfile"
    destination = "/opt/dofek/Caddyfile"
  }

  provisioner "file" {
    source      = "${path.module}/../otel-collector-config.yaml"
    destination = "/opt/dofek/otel-collector-config.yaml"
  }

  provisioner "file" {
    source      = "${path.module}/../../src/index.ts"
    destination = "/opt/dofek/patches/index.ts"
  }

  provisioner "file" {
    source      = "${path.module}/../../src/providers/index.ts"
    destination = "/opt/dofek/patches/providers-index.ts"
  }

  provisioner "file" {
    source      = "${path.module}/../../src/jobs/process-sync-job.ts"
    destination = "/opt/dofek/patches/process-sync-job.ts"
  }

  provisioner "file" {
    source      = "${path.module}/../../src/jobs/process-scheduled-sync-job.ts"
    destination = "/opt/dofek/patches/process-scheduled-sync-job.ts"
  }

  provisioner "file" {
    source      = "${path.module}/../../src/jobs/process-training-export-job.ts"
    destination = "/opt/dofek/patches/process-training-export-job.ts"
  }

  provisioner "remote-exec" {
    inline = [
      "cd /opt/dofek && docker compose -f docker-compose.yml -f docker-compose.hotfix.yml up -d --scale web=2 --scale client=2"
    ]
  }
}
