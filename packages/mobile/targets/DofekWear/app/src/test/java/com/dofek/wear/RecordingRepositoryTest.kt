package com.dofek.wear

import org.junit.Assert.assertEquals
import org.junit.Test

class RecordingRepositoryTest {
    @Test
    fun `append durably records a sample before transfer is attempted`() {
        val store = InMemoryRecordingStore()
        val transfer = RecordingTransferSpy()
        val repository = RecordingRepository(store, transfer)

        repository.append(MotionSample("2026-08-30T20:00:00.000Z", 1.0, 2.0, 3.0))

        assertEquals(listOf("wear-motion-1.json.gz"), repository.pendingFiles())
        assertEquals(emptyList<String>(), transfer.enqueuedFileNames)
    }

    @Test
    fun `successful transfer deletes only the persisted file it enqueued`() {
        val store = InMemoryRecordingStore()
        val transfer = RecordingTransferSpy()
        val repository = RecordingRepository(store, transfer)
        repository.append(MotionSample("2026-08-30T20:00:00.000Z", 1.0, 2.0, 3.0))

        repository.transferPending()

        assertEquals(listOf("wear-motion-1.json.gz"), transfer.enqueuedFileNames)
        assertEquals(emptyList<String>(), repository.pendingFiles())
    }

    @Test
    fun `new recordings never reuse a delivered file name`() {
        val store = InMemoryRecordingStore()
        val repository = RecordingRepository(store, RecordingTransferSpy())
        repository.append(MotionSample("2026-08-30T20:00:00.000Z", 1.0, 2.0, 3.0))
        repository.transferPending()

        repository.append(MotionSample("2026-08-30T20:01:00.000Z", 4.0, 5.0, 6.0))

        assertEquals(listOf("wear-motion-2.json.gz"), repository.pendingFiles())
    }
}

private class InMemoryRecordingStore : RecordingStore {
    private val recordings = linkedMapOf<String, PendingRecording>()
    private var nextSequence = 1

    override fun reserveFileName(): String = "wear-motion-${nextSequence++}.json.gz"

    override fun save(recording: PendingRecording) {
        recordings[recording.fileName] = recording
    }

    override fun list(): List<PendingRecording> = recordings.values.toList()

    override fun delete(fileName: String) {
        recordings.remove(fileName)
    }
}

private class RecordingTransferSpy : WearTransferClient {
    val enqueuedFileNames = mutableListOf<String>()

    override fun enqueue(recording: PendingRecording): Boolean {
        enqueuedFileNames += recording.fileName
        return true
    }
}
