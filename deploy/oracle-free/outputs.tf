output "instance_id" {
  description = "OCID of the provisioned compute instance"
  value       = oci_core_instance.dofek.id
}

output "public_ip" {
  description = "Reserved (static) public IP of the instance. Store this in the ORACLE_SERVER_HOST GitHub Actions variable."
  value       = oci_core_public_ip.dofek.ip_address
}

output "ssh_command" {
  description = "Convenience SSH command (default user is 'ubuntu' on Oracle Ubuntu images)"
  value       = "ssh ubuntu@${oci_core_public_ip.dofek.ip_address}"
}
