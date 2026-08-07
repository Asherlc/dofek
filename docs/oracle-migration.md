# Oracle Migration

Production has already moved from Hetzner to Oracle Cloud Always Free.

This file is retained as a historical marker rather than an active runbook. The
current production host is the OCI instance provisioned by
`deploy/oracle-free/`, with its reserved public IP stored in the
`ORACLE_SERVER_HOST` GitHub Actions variable. The main `deploy/` Terraform root
uses that variable for production DNS and no longer manages a production
Hetzner server or volume.

For a future production host migration, use the same high-level data rule:
PostgreSQL is canonical and must be dumped/restored or otherwise replicated
with verification; ClickHouse, Redis, PeerDB catalog state, and transient Docker
volumes are derived or recreatable unless a new runbook explicitly says
otherwise.
