import Foundation

extension Data {
    func readUInt16LE(at offset: Int) -> UInt16 {
        guard offset + 2 <= endIndex else { return 0 }
        return UInt16(self[offset]) | (UInt16(self[offset + 1]) << 8)
    }

    func readInt16LE(at offset: Int) -> Int16 {
        return Int16(bitPattern: readUInt16LE(at: offset))
    }

    func readUInt32LE(at offset: Int) -> UInt32 {
        guard offset + 4 <= endIndex else { return 0 }
        return UInt32(self[offset])
            | (UInt32(self[offset + 1]) << 8)
            | (UInt32(self[offset + 2]) << 16)
            | (UInt32(self[offset + 3]) << 24)
    }

    func readFloat32LE(at offset: Int) -> Float {
        let bits = readUInt32LE(at: offset)
        return Float(bitPattern: bits)
    }
}
