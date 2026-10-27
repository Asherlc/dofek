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

enum HealthKitAnchoredQueryCoordinatorError: LocalizedError {
    case unknownQuery(typeIdentifier: String, queryId: String)
    case mismatchedType(expected: String, actual: String)

    var errorDescription: String? {
        switch self {
        case let .unknownQuery(typeIdentifier, queryId):
            return "No pending HealthKit anchor query \(queryId) exists for \(typeIdentifier)"
        case let .mismatchedType(expected, actual):
            return "HealthKit anchor query belongs to \(expected), not \(actual)"
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

struct HealthKitPendingAnchoredQuery<Result> {
    let result: Result
    let queryId: String?
}

final class HealthKitAnchoredQueryCoordinator {
    private struct PendingAnchor {
        let anchor: HKQueryAnchor
        let typeIdentifier: String
    }

    private let anchorStore: HealthKitAnchorStore
    private let pendingLock = NSLock()
    private var pendingAnchors: [String: PendingAnchor] = [:]
    private var generation: UInt64 = 0

    init(anchorStore: HealthKitAnchorStore) {
        self.anchorStore = anchorStore
    }

    func run<Result>(
        typeIdentifier: String,
        query: (HKQueryAnchor?) async throws -> (result: Result, newAnchor: HKQueryAnchor?)
    ) async throws -> HealthKitPendingAnchoredQuery<Result> {
        let anchor = try anchorStore.load(typeIdentifier: typeIdentifier)
        let queryGeneration = pendingLock.withLock { generation }
        let queryResult = try await query(anchor)
        guard let newAnchor = queryResult.newAnchor else {
            return HealthKitPendingAnchoredQuery(result: queryResult.result, queryId: nil)
        }

        let queryId = UUID().uuidString
        let pendingQueryId = pendingLock.withLock { () -> String? in
            guard generation == queryGeneration else { return nil }
            pendingAnchors[queryId] = PendingAnchor(
                anchor: newAnchor,
                typeIdentifier: typeIdentifier
            )
            return queryId
        }
        return HealthKitPendingAnchoredQuery(result: queryResult.result, queryId: pendingQueryId)
    }

    func invalidatePendingQueries() {
        pendingLock.withLock {
            generation &+= 1
            pendingAnchors.removeAll()
        }
    }

    func complete(typeIdentifier: String, queryId: String, succeeded: Bool) throws {
        let pendingAnchor = try pendingLock.withLock {
            guard let pendingAnchor = pendingAnchors[queryId] else {
                throw HealthKitAnchoredQueryCoordinatorError.unknownQuery(
                    typeIdentifier: typeIdentifier,
                    queryId: queryId
                )
            }
            guard pendingAnchor.typeIdentifier == typeIdentifier else {
                throw HealthKitAnchoredQueryCoordinatorError.mismatchedType(
                    expected: pendingAnchor.typeIdentifier,
                    actual: typeIdentifier
                )
            }
            pendingAnchors.removeValue(forKey: queryId)
            return pendingAnchor
        }

        guard succeeded else {
            return
        }
        try anchorStore.save(pendingAnchor.anchor, typeIdentifier: typeIdentifier)
    }
}
