package com.dofek.wear

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.wear.compose.foundation.lazy.TransformingLazyColumn
import androidx.wear.compose.foundation.lazy.rememberTransformingLazyColumnState
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.Text

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            val directory = remember { filesDir.resolve("wear-motion-pending") }
            val repository = remember {
                RecordingRepository(
                    FileRecordingStore(directory),
                    WearDataLayerTransferClient(this, directory),
                )
            }
            val recorder = remember { MotionSensorRecorder(this, repository) }
            var isRecording by remember { mutableStateOf(false) }
            val state = rememberTransformingLazyColumnState()
            TransformingLazyColumn(state = state) {
                item { Text("Dofek Wear") }
                item { Text("${repository.pendingFiles().size} pending recordings") }
                item {
                    Button(onClick = {
                        isRecording = if (isRecording) {
                            recorder.stop()
                            false
                        } else {
                            recorder.start()
                        }
                    }) { Text(if (isRecording) "Stop recording" else "Start recording") }
                }
                item {
                    Button(onClick = repository::transferPending) { Text("Sync now") }
                }
            }
        }
    }
}
