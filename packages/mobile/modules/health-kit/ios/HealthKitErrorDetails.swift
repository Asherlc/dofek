import Foundation
import HealthKit

struct HealthKitErrorDetails: Equatable {
    static let databaseInaccessibleCode = "HEALTHKIT_DATABASE_INACCESSIBLE"
    static let authorizationNotDeterminedCode = "HEALTHKIT_AUTHORIZATION_NOT_DETERMINED"

    let code: String
    let reason: String

    static func isAuthorizationNotDetermined(_ error: Error) -> Bool {
        let nativeError = error as NSError
        return nativeError.domain == HKErrorDomain &&
            nativeError.code == HKError.Code.errorAuthorizationNotDetermined.rawValue
    }

    static func shouldReportObserverError(_ error: Error) -> Bool {
        return !isAuthorizationNotDetermined(error)
    }

    init(operation: String, fallbackCode: String, error: Error) {
        let nativeError = error as NSError
        if Self.isAuthorizationNotDetermined(error) {
            self.code = Self.authorizationNotDeterminedCode
        } else if Self.isDatabaseInaccessible(nativeError) {
            self.code = Self.databaseInaccessibleCode
        } else {
            self.code = fallbackCode
        }
        self.reason = "\(operation) failed: \(nativeError.localizedDescription) " +
            "(\(nativeError.domain):\(nativeError.code))"
    }

    private static func isDatabaseInaccessible(_ error: NSError) -> Bool {
        return error.domain == HKErrorDomain &&
            error.code == HKError.Code.errorDatabaseInaccessible.rawValue
    }
}
