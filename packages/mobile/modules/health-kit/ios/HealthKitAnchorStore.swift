import Foundation
import HealthKit

enum HealthKitAnchorStoreError: LocalizedError {
    case decodeFailed(typeIdentifier: String, underlyingError: Error)
    case encodeFailed(typeIdentifier: String, underlyingError: Error)
    case unsupportedStoredValue(typeIdentifier: String, valueType: String)

    var errorDescription: String? {
        switch self {
        case let .decodeFailed(typeIdentifier, underlyingError):
            return "Could not decode the persisted HealthKit anchor for \(typeIdentifier): \(underlyingError.localizedDescription)"
        case let .encodeFailed(typeIdentifier, underlyingError):
            return "Could not encode the HealthKit anchor for \(typeIdentifier): \(underlyingError.localizedDescription)"
        case let .unsupportedStoredValue(typeIdentifier, valueType):
            return "Discarded a legacy HealthKit anchor for \(typeIdentifier) stored as \(valueType)"
        }
    }
}

final class HealthKitAnchorStore {
    private let userDefaults: UserDefaults

    init(userDefaults: UserDefaults) {
        self.userDefaults = userDefaults
    }

    static func key(for typeIdentifier: String) -> String {
        return "healthkit_anchor_\(typeIdentifier)"
    }

    func load(typeIdentifier: String) throws -> HKQueryAnchor? {
        let key = Self.key(for: typeIdentifier)
        guard let storedValue = userDefaults.object(forKey: key) else {
            return nil
        }
        guard let data = storedValue as? Data else {
            userDefaults.removeObject(forKey: key)
            throw HealthKitAnchorStoreError.unsupportedStoredValue(
                typeIdentifier: typeIdentifier,
                valueType: String(describing: type(of: storedValue))
            )
        }

        do {
            guard let anchor = try NSKeyedUnarchiver.unarchivedObject(
                ofClass: HKQueryAnchor.self,
                from: data
            ) else {
                throw CocoaError(.coderReadCorrupt)
            }
            return anchor
        } catch {
            userDefaults.removeObject(forKey: key)
            throw HealthKitAnchorStoreError.decodeFailed(
                typeIdentifier: typeIdentifier,
                underlyingError: error
            )
        }
    }

    func save(_ anchor: HKQueryAnchor, typeIdentifier: String) throws {
        do {
            let data = try NSKeyedArchiver.archivedData(
                withRootObject: anchor,
                requiringSecureCoding: true
            )
            userDefaults.set(data, forKey: Self.key(for: typeIdentifier))
        } catch {
            throw HealthKitAnchorStoreError.encodeFailed(
                typeIdentifier: typeIdentifier,
                underlyingError: error
            )
        }
    }
}

final class HealthKitAnchoredQueryCoordinator {
    private let anchorStore: HealthKitAnchorStore

    init(anchorStore: HealthKitAnchorStore) {
        self.anchorStore = anchorStore
    }

    func run<Result>(
        typeIdentifier: String,
        query: (HKQueryAnchor?) async throws -> (result: Result, newAnchor: HKQueryAnchor?)
    ) async throws -> Result {
        let anchor = try anchorStore.load(typeIdentifier: typeIdentifier)
        let queryResult = try await query(anchor)
        if let newAnchor = queryResult.newAnchor {
            try anchorStore.save(newAnchor, typeIdentifier: typeIdentifier)
        }
        return queryResult.result
    }
}
