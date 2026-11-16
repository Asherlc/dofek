import Foundation

typealias WhoopUploadCompletionContext = (
    attempt: Int?, responseURL: URL?, taskIdentifier: Int?, transportPath: String?
)
typealias WhoopUploadCompletion = (
    String, Int?, Data, WhoopUploadCompletionContext, Error?
) -> Void

struct WhoopUploadOutcome {
    let batchIdentity: String
    let stream: String
    let route: String
    var stage: String
    let statusCode: Int?
    var responseOriginValidated: Bool?
    var acknowledgmentValidated: Bool
    var outboxState: String
    let batchSampleCount: Int?
    let attempt: Int?
    let taskIdentifier: Int?
    let transportPath: String?
    let siblingTaskPending: Bool?
    let occurredAt: String

    var isValidatedHttp5xxRejection: Bool {
        responseOriginValidated == true && stage == "http_status_rejected" &&
            statusCode.map { (500..<600).contains($0) } == true
    }

    var sentryData: [String: Any] {
        var data: [String: Any] = [
            "batchIdentity": batchIdentity,
            "stream": stream,
            "route": route,
            "stage": stage,
            "acknowledgmentValidated": acknowledgmentValidated,
            "outboxState": outboxState,
            "occurredAt": occurredAt,
        ]
        if let statusCode { data["statusCode"] = statusCode }
        if let responseOriginValidated { data["responseOriginValidated"] = responseOriginValidated }
        if let batchSampleCount { data["batchSampleCount"] = batchSampleCount }
        if let attempt { data["attempt"] = attempt }
        if let taskIdentifier { data["taskIdentifier"] = taskIdentifier }
        if let transportPath { data["transportPath"] = transportPath }
        if let siblingTaskPending { data["siblingTaskPending"] = siblingTaskPending }
        return data
    }
}

enum WhoopUploadTelemetry {
    static let contextKey = "com.dofek.whoop_upload_context"
    static let transportContextKey = "com.dofek.whoop_upload_transport_context"

    static func adding(_ context: [String: Any], to error: Error, key: String = contextKey) -> NSError {
        let original = error as NSError
        var userInfo = original.userInfo
        userInfo[key] = context
        return NSError(domain: original.domain, code: original.code, userInfo: userInfo)
    }
}

struct WhoopUploadResponse {
    let status: Int?
    let data: Data
    let responseURL: URL?
    let error: Error?
}
