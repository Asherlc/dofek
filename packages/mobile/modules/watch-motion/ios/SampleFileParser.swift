import Foundation

/// Parses accelerometer sample files transferred from the Apple Watch.
/// Handles both zlib-compressed and plain JSON files.
///
/// This is extracted from WatchMotionModule so it can be tested independently
/// via Swift Package Manager, verifying the compression round-trip between
/// Watch (compress) and iPhone (decompress).
public enum SampleFileParser {
    /// Parse a single accelerometer sample file.
    /// The file may be zlib-compressed (as produced by the Watch's TransferManager)
    /// or plain JSON.
    ///
    /// - Parameter data: Raw file contents
    /// - Returns: Array of sample dictionaries with "timestamp", "x", "y", "z" keys
    /// - Throws: If both decompression and JSON parsing fail
    public static func parse(_ data: Data) throws -> [[String: Any]] {
        let decompressedData: Data
        do {
            decompressedData = try (data as NSData).decompressed(using: .zlib) as Data
        } catch {
            // Not zlib-compressed — treat as plain JSON
            decompressedData = data
        }

        guard let jsonArray = try JSONSerialization.jsonObject(with: decompressedData) as? [[String: Any]] else {
            throw SampleFileParserError.notAnArray
        }

        return jsonArray
    }

    /// Compress sample data the same way the Watch does (zlib via NSData).
    /// Useful for testing the round-trip.
    public static func compress(_ jsonArray: [[String: Any]]) throws -> Data {
        let jsonData = try JSONSerialization.data(withJSONObject: jsonArray)
        return try (jsonData as NSData).compressed(using: .zlib) as Data
    }
}

public enum SampleFileParserError: Error, CustomStringConvertible {
    case notAnArray

    public var description: String {
        switch self {
        case .notAnArray:
            return "JSON content is not an array of sample dictionaries"
        }
    }
}
