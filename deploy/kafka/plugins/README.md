# Plugin extract tree

Gitignored jar contents. Production publish path:

`/mnt/dofek-data/kafka/plugins/1.2.0/{core,s3}`

Populate via the deploy-web-stack “Provision Kafka RSM plugins” step (curl +
sha256 + exact roots + atomic version-pair `mv` if absent). See
[`../README.md`](../README.md).
