import Foundation

extension TransferManager {
    /// Compress a file using zlib via Foundation's NSData.compressed(using:).
    ///
    /// Uses memory-mapped input so large recordings do not need to be loaded into
    /// memory all at once.
    static func compressFile(from sourceURL: URL, to destURL: URL) throws -> Int {
        let sourceData = try Data(contentsOf: sourceURL, options: .mappedIfSafe)
        let compressedData = try (sourceData as NSData).compressed(using: .zlib) as Data
        try compressedData.write(to: destURL)
        return compressedData.count
    }
}
