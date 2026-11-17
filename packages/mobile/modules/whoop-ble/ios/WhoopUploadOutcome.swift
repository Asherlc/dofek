import Foundation

struct WhoopUploadOutcome {
    let batchIdentity: String
    let stream: String
    let route: String
    var stage: String
    let statusCode: Int?
    var responseOriginValidated: Bool?
    var acknowledgmentValidated: Bool
    var outboxState: String

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
        ]
        if let statusCode { data["statusCode"] = statusCode }
        if let responseOriginValidated { data["responseOriginValidated"] = responseOriginValidated }
        return data
    }
}
