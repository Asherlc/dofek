# Reserved (static) public IP for the instance.
#
# An ephemeral public IP changes on every instance recreate, which breaks CI
# (the deploy job needs a stable SSH host) and DNS. A reserved public IP keeps
# the same address even when the instance is replaced: on recreate Terraform
# reassigns this reserved IP to the new VNIC's private IP, so the address —
# and therefore production DNS and the ORACLE_SERVER_HOST variable — never
# changes. Reserved public IPs are free within the Always Free tier.
#
# create_vnic_details.assign_public_ip is set to false in compute.tf so the
# private IP has no ephemeral public IP to conflict with this assignment.

data "oci_core_vnic_attachments" "dofek" {
  compartment_id = var.compartment_ocid
  instance_id    = oci_core_instance.dofek.id
}

data "oci_core_private_ips" "dofek" {
  vnic_id = data.oci_core_vnic_attachments.dofek.vnic_attachments[0].vnic_id
}

resource "oci_core_public_ip" "dofek" {
  compartment_id = var.compartment_ocid
  lifetime       = "RESERVED"
  # Bind to the VNIC's primary private IP explicitly — the private_ips list is
  # not ordered, so [0] could be a secondary IP.
  private_ip_id = one([for ip in data.oci_core_private_ips.dofek.private_ips : ip.id if ip.is_primary])
  display_name  = "dofek-reserved"
}
