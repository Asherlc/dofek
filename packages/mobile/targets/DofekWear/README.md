# Dofek Wear

Wear OS 3+ companion that records raw accelerometer samples into a local
pending-file store before it asks the Wearable Data Layer to transfer them to
the paired phone. The phone is the credential and upload boundary.

Compose for Wear OS uses the Wear-specific Compose libraries, and the Data
Layer channel transports file streams between paired nodes; see the official
[Compose setup](https://developer.android.com/training/wearables/compose) and
[Data Layer client guidance](https://developer.android.com/training/wearables/data/client-types).

## Validation

With Android JDK and Gradle available:

```bash
./gradlew test
```
