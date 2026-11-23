import Foundation
import zlib

enum WhoopUploadGzip {
    static func encode(_ body: Data) throws -> Data {
        var stream = z_stream()
        // Adding 16 to the window size writes the gzip header and trailer.
        let initialization = deflateInit2_(
            &stream, Z_BEST_SPEED, Z_DEFLATED, MAX_WBITS + 16, 8, Z_DEFAULT_STRATEGY,
            ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size)
        )
        guard initialization == Z_OK else {
            throw WhoopUploadError(message: "Could not initialize WHOOP gzip encoder (\(initialization))")
        }
        defer { deflateEnd(&stream) }

        let capacity = Int(deflateBound(&stream, uLong(body.count)))
        var encoded = Data(count: capacity)
        let result = body.withUnsafeBytes { source in
            encoded.withUnsafeMutableBytes { destination in
                stream.next_in = UnsafeMutablePointer(mutating: source.bindMemory(to: Bytef.self).baseAddress)
                stream.avail_in = uInt(body.count)
                stream.next_out = destination.bindMemory(to: Bytef.self).baseAddress
                stream.avail_out = uInt(capacity)
                return deflate(&stream, Z_FINISH)
            }
        }
        guard result == Z_STREAM_END else {
            throw WhoopUploadError(message: "Could not encode WHOOP upload with gzip (\(result))")
        }
        encoded.count = Int(stream.total_out)
        return encoded
    }
}
