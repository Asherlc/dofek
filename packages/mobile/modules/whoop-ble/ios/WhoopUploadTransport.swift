import Foundation

protocol WhoopUploadTransport: AnyObject {
    var onCompletion: WhoopUploadCompletion? { get set }
    var onFinishEvents: (() -> Void)? { get set }
    func allTasks(_ completion: @escaping (Set<String>) -> Void)
    /// Returns false while the uploader still owns an earlier terminal result for this reservation.
    @discardableResult
    func start(request: URLRequest, file: URL, identity: String, attempt: Int) -> Bool
    func cancel(identity: String)
}
