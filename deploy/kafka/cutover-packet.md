# Cutover packet location

Use the single [Kafka with tiered storage release packet](tiered-cutover-packet.md).
Broker PR #3233 and tiered PR #3236 remain separate review layers, with no
standalone hot-log activation. No merge, deployment or retirement is authorized.

The [earlier broker-only packet](https://github.com/Asherlc/dofek/blob/4096c83cf/deploy/kafka/cutover-packet.md)
preserves dated protocol/image observations and the withdrawn hot-log proposal.
Its remote-disabled configuration and worker proof are historical. Current
artifacts, commands, decision gates and recovery limits belong only to the
canonical packet above.
