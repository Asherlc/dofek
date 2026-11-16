import Foundation

struct WhoopUploadResponse {
    let status: Int?
    let data: Data
    let responseURL: URL?
    let error: Error?

    var originString: String? {
        guard let responseURL,
              var parts = URLComponents(url: responseURL, resolvingAgainstBaseURL: false) else { return nil }
        parts.path = ""
        parts.query = nil
        parts.fragment = nil
        return parts.string
    }
}
