plugin "terraform" {
  enabled = true
  preset  = "recommended"
}

config {
  call_module_type = "local"
  force            = false
}
