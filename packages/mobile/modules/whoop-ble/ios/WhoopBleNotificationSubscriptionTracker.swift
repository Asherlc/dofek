/// Tracks the notification subscriptions that belong to one connection attempt.
///
/// CoreBluetooth reports notification changes asynchronously. Object identity
/// prevents a late callback from an earlier peripheral or characteristic from
/// completing the current handshake.
struct WhoopBleNotificationSubscriptionTracker {
    enum UpdateResult: Equatable {
        case ignored
        case waiting
        case ready
        case failed
    }

    private let peripheralIdentity: ObjectIdentifier
    private var pendingCharacteristicIdentities: Set<ObjectIdentifier>

    init(
        peripheral: AnyObject,
        dataCharacteristic: AnyObject,
        commandResponseCharacteristic: AnyObject?
    ) {
        peripheralIdentity = ObjectIdentifier(peripheral)
        pendingCharacteristicIdentities = [ObjectIdentifier(dataCharacteristic)]
        if let commandResponseCharacteristic {
            pendingCharacteristicIdentities.insert(ObjectIdentifier(commandResponseCharacteristic))
        }
    }

    mutating func recordNotificationState(
        peripheral: AnyObject,
        characteristic: AnyObject,
        isNotifying: Bool,
        hasError: Bool
    ) -> UpdateResult {
        let characteristicIdentity = ObjectIdentifier(characteristic)
        guard
            ObjectIdentifier(peripheral) == peripheralIdentity,
            pendingCharacteristicIdentities.contains(characteristicIdentity)
        else {
            return .ignored
        }

        guard !hasError, isNotifying else {
            return .failed
        }

        pendingCharacteristicIdentities.remove(characteristicIdentity)
        return pendingCharacteristicIdentities.isEmpty ? .ready : .waiting
    }
}
