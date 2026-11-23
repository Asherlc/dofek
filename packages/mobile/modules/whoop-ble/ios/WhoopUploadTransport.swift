import Foundation

protocol WhoopUploadTransport: AnyObject {
    var onCompletion: WhoopUploadCompletion? { get set }
    var onFinishEvents: (() -> Void)? { get set }
    func allTasks(_ completion: @escaping (Set<String>) -> Void)
    func start(request: URLRequest, file: URL, identity: String, attempt: Int)
    func cancel(identity: String)
}
