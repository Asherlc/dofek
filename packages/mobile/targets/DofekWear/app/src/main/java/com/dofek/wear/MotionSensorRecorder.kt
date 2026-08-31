package com.dofek.wear

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import java.time.Instant

/** Foreground raw-accelerometer recorder; every received observation crosses the durable repository boundary. */
class MotionSensorRecorder(
    context: Context,
    private val repository: RecordingRepository,
) : SensorEventListener {
    private val sensorManager = context.getSystemService(SensorManager::class.java)
    private val accelerometer = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)

    fun start(): Boolean {
        val sensor = accelerometer ?: return false
        return sensorManager.registerListener(this, sensor, SensorManager.SENSOR_DELAY_NORMAL)
    }

    fun stop() {
        sensorManager.unregisterListener(this)
    }

    override fun onSensorChanged(event: SensorEvent) {
        repository.append(
            MotionSample(
                timestamp = Instant.now().toString(),
                x = event.values[0].toDouble(),
                y = event.values[1].toDouble(),
                z = event.values[2].toDouble(),
            ),
        )
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
}
