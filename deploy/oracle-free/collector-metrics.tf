# Post-bootstrap directory provisioning without changing instance user_data.
# https://developer.hashicorp.com/terraform/language/resources/terraform-data
resource "terraform_data" "collector_metrics_directory" {
  count = var.data_volume_size_gb > 0 ? 1 : 0

  triggers_replace = {
    instance   = oci_core_instance.dofek.id
    attachment = oci_core_volume_attachment.data[count.index].id
    directory  = "/mnt/dofek-data/collector-metrics"
  }

  # Reuse the operator's SSH agent and verified known_hosts; do not disable
  # host identity checks or copy credentials onto the host.
  provisioner "local-exec" {
    command = <<-EOT
      ssh -o BatchMode=yes -o StrictHostKeyChecking=yes ubuntu@${oci_core_public_ip.dofek.ip_address} \
        'sudo -n cloud-init status --wait && sudo -n sh -ec "mountpoint -q /mnt/dofek-data; install -d -o root -g root -m 0755 /mnt/dofek-data/collector-metrics"'
    EOT
  }
}
