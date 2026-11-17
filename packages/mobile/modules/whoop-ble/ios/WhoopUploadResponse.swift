import Foundation

struct WhoopUploadResponse {
    let status: Int?
    let data: Data
    let responseURL: URL?
    let error: Error?

    static func validatedOrigin(_ value: String) throws -> String {
        guard let parts = URLComponents(string: value), let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/" else {
            throw WhoopUploadError(message: "WHOOP server URL must be an HTTPS origin")
        }
        var allowed = parts.scheme?.lowercased() == "https"
        #if DEBUG
        allowed = allowed || (parts.scheme == "http" && ["localhost", "127.0.0.1", "::1"].contains(host))
        #endif
        guard allowed else { throw WhoopUploadError(message: "WHOOP server URL must use HTTPS") }
        var normalized = parts
        normalized.path = ""
        normalized.scheme = parts.scheme?.lowercased()
        normalized.host = host.lowercased()
        guard let origin = normalized.string else { throw WhoopUploadError(message: "Invalid WHOOP server origin") }
        return origin
    }

    var originString: String? {
        guard let responseURL,
              var parts = URLComponents(url: responseURL, resolvingAgainstBaseURL: false) else { return nil }
        parts.path = ""
        parts.query = nil
        parts.fragment = nil
        return parts.string
    }
}
