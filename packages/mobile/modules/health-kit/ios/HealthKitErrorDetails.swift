import Foundation
import HealthKit

struct HealthKitErrorDetails: Equatable {
    static let databaseInaccessibleCode = "HEALTHKIT_DATABASE_INACCESSIBLE"

    let code: String
    let reason: String

    init(operation: String, fallbackCode: String, error: Error) {
        let nativeError = error as NSError
        self.code = Self.isDatabaseInaccessible(nativeError)
            ? Self.databaseInaccessibleCode
            : fallbackCode
        self.reason = "\(operation) failed: \(nativeError.localizedDescription) " +
            "(\(nativeError.domain):\(nativeError.code))"
    }

    private static func isDatabaseInaccessible(_ error: NSError) -> Bool {
        return error.domain == HKErrorDomain &&
            error.code == HKError.Code.errorDatabaseInaccessible.rawValue
    }
}
