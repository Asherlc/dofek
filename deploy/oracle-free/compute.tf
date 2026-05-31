# Latest Canonical Ubuntu 24.04 image compatible with the A1 (aarch64) shape.
# Filtering by shape guarantees an ARM64 image so the shape list never gets
# silently filtered out the way it does in the Console.
data "oci_core_images" "ubuntu" {
  compartment_id           = var.compartment_ocid
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "24.04"
  shape                    = "VM.Standard.A1.Flex"
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

resource "oci_core_instance" "dofek" {
  compartment_id      = var.compartment_ocid
  availability_domain = data.oci_identity_availability_domains.ads.availability_domains[var.availability_domain_index].name
  display_name        = var.instance_display_name
  shape               = "VM.Standard.A1.Flex"

  shape_config {
    ocpus         = var.instance_ocpus
    memory_in_gbs = var.instance_memory_gb
  }

  # Fail clearly at plan time if the image filter returns nothing, instead of an
  # opaque "index 0 out of range" on data.oci_core_images.ubuntu.images[0].
  lifecycle {
    precondition {
      condition     = length(data.oci_core_images.ubuntu.images) > 0
      error_message = "No Canonical Ubuntu 24.04 image found for shape VM.Standard.A1.Flex in this region."
    }
  }

  # Require IMDSv2 (disable the legacy unauthenticated v1 metadata endpoint),
  # which mitigates SSRF-based credential theft from the instance metadata service.
  instance_options {
    are_legacy_imds_endpoints_disabled = true
  }

  source_details {
    source_type             = "image"
    source_id               = data.oci_core_images.ubuntu.images[0].id
    boot_volume_size_in_gbs = var.boot_volume_size_gb
  }

  create_vnic_details {
    subnet_id = oci_core_subnet.dofek.id
    # No ephemeral public IP: a reserved public IP is attached instead
    # (see reserved-ip.tf) so the address survives instance recreates.
    assign_public_ip = false
  }

  metadata = {
    ssh_authorized_keys = var.ssh_public_key
    user_data = base64encode(templatefile("${path.module}/cloud-init.yml", {
      data_volume_enabled = var.data_volume_size_gb > 0
    }))
  }
}

# Dedicated data volume mounted at /mnt/dofek-data so the production stack.yml
# bind mounts (postgres/, clickhouse/, ...) work consistently across hosts.
# Paravirtualized attachment avoids the iSCSI login dance; the device name is
# discovered in cloud-init (Ubuntu images lack the Oracle-Linux
# /dev/oracleoci/* consistent-path symlinks).
resource "oci_core_volume" "data" {
  count               = var.data_volume_size_gb > 0 ? 1 : 0
  compartment_id      = var.compartment_ocid
  availability_domain = data.oci_identity_availability_domains.ads.availability_domains[var.availability_domain_index].name
  display_name        = "dofek-data"
  size_in_gbs         = var.data_volume_size_gb
}

resource "oci_core_volume_attachment" "data" {
  count           = var.data_volume_size_gb > 0 ? 1 : 0
  attachment_type = "paravirtualized"
  instance_id     = oci_core_instance.dofek.id
  volume_id       = oci_core_volume.data[0].id
}
