package com.dofek.wear

import android.content.Context
import androidx.core.net.toUri
import com.google.android.gms.wearable.Wearable
import java.io.File

interface WearTransferClient {
    /** Returns true only after the Data Layer accepts the already-persisted file. */
    fun enqueue(recording: PendingRecording): Boolean
}

class WearDataLayerTransferClient(
    private val context: Context,
    private val recordingDirectory: File,
) : WearTransferClient {
    override fun enqueue(recording: PendingRecording): Boolean {
        val node = Wearable.getNodeClient(context).connectedNodes.result.firstOrNull() ?: return false
        val channelClient = Wearable.getChannelClient(context)
        val channel = channelClient
            .openChannel(node.id, "/wear-motion/${recording.fileName}")
            .result
        channelClient.sendFile(channel, File(recordingDirectory, recording.fileName).toUri()).result
        return true
    }
}
