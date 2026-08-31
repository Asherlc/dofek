package com.dofek.wear

import java.io.File
import java.util.zip.GZIPOutputStream

data class MotionSample(
    val timestamp: String,
    val x: Double,
    val y: Double,
    val z: Double,
)

data class PendingRecording(
    val fileName: String,
    val payload: ByteArray,
)

interface RecordingStore {
    fun reserveFileName(): String
    fun save(recording: PendingRecording)
    fun list(): List<PendingRecording>
    fun delete(fileName: String)
}

/**
 * Owns the durable boundary between a sensor observation and Data Layer delivery.
 * An observation is always saved first; transport never receives an unpersisted payload.
 */
class RecordingRepository(
    private val store: RecordingStore,
    private val transferClient: WearTransferClient,
) {
    fun append(sample: MotionSample) {
        val nextFileName = store.reserveFileName()
        store.save(PendingRecording(nextFileName, gzip(encode(sample))))
    }

    fun pendingFiles(): List<String> = store.list().map(PendingRecording::fileName)

    fun transferPending() {
        store.list().forEach { recording ->
            if (transferClient.enqueue(recording)) {
                store.delete(recording.fileName)
            }
        }
    }

    private fun encode(sample: MotionSample): ByteArray =
        "[{\"timestamp\":\"${sample.timestamp}\",\"x\":${sample.x},\"y\":${sample.y},\"z\":${sample.z}}]"
            .encodeToByteArray()

    private fun gzip(payload: ByteArray): ByteArray =
        java.io.ByteArrayOutputStream().use { output ->
            GZIPOutputStream(output).use { it.write(payload) }
            output.toByteArray()
        }

}

class FileRecordingStore(private val directory: File) : RecordingStore {
    override fun reserveFileName(): String {
        directory.mkdirs()
        val sequenceFile = File(directory, ".next-sequence")
        val next = sequenceFile.takeIf(File::exists)?.readText()?.trim()?.toIntOrNull() ?: 1
        val temporary = File(directory, ".next-sequence.tmp")
        temporary.writeText((next + 1).toString())
        check(temporary.renameTo(sequenceFile)) { "Could not reserve Wear recording sequence" }
        return "wear-motion-$next.json.gz"
    }

    override fun save(recording: PendingRecording) {
        directory.mkdirs()
        val destination = File(directory, recording.fileName)
        val temporary = File(directory, ".${recording.fileName}.tmp")
        temporary.outputStream().use { it.write(recording.payload) }
        check(temporary.renameTo(destination)) { "Could not persist ${recording.fileName}" }
    }

    override fun list(): List<PendingRecording> =
        directory.listFiles()
            ?.filter { it.isFile && it.name.startsWith("wear-motion-") && it.name.endsWith(".json.gz") }
            ?.sortedBy(File::name)
            ?.map { PendingRecording(it.name, it.readBytes()) }
            ?: emptyList()

    override fun delete(fileName: String) {
        File(directory, fileName).delete()
    }
}
