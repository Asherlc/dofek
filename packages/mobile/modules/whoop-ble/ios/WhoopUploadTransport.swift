import Foundation

struct WhoopUploadTaskSnapshot {
    let identities: Set<String>
    /// Reservations with both a live request and an OS-managed fallback.
    let pairedIdentities: Set<String>
}

protocol WhoopUploadTransport: AnyObject {
    var onCompletion: WhoopUploadCompletion? { get set }
    var onAttemptFailure: ((String, Error, Int?) -> Void)? { get set }
    var onFinishEvents: (() -> Void)? { get set }
    func allTasks(_ completion: @escaping (WhoopUploadTaskSnapshot) -> Void)
    func start(request: URLRequest, file: URL, identity: String, attempt: Int)
    func cancel(identity: String)
}
