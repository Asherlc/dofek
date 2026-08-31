package expo.modules.healthconnect

import android.app.Activity
import androidx.activity.result.contract.ActivityResultContract
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.BodyFatRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.FloorsClimbedRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.OxygenSaturationRecord
import androidx.health.connect.client.records.RespiratoryRateRecord
import androidx.health.connect.client.records.RestingHeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.Vo2MaxRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.time.Duration
import java.time.Instant
import kotlinx.coroutines.launch

class HealthConnectModule : Module() {
  private val requiredPermissions = setOf(
    HealthPermission.getReadPermission(StepsRecord::class),
    HealthPermission.getReadPermission(DistanceRecord::class),
    HealthPermission.getReadPermission(FloorsClimbedRecord::class),
    HealthPermission.getReadPermission(ExerciseSessionRecord::class),
    HealthPermission.getReadPermission(SleepSessionRecord::class),
    HealthPermission.getReadPermission(WeightRecord::class),
    HealthPermission.getReadPermission(BodyFatRecord::class),
    HealthPermission.getReadPermission(HeartRateRecord::class),
    HealthPermission.getReadPermission(RestingHeartRateRecord::class),
    HealthPermission.getReadPermission(OxygenSaturationRecord::class),
    HealthPermission.getReadPermission(RespiratoryRateRecord::class),
    HealthPermission.getReadPermission(Vo2MaxRecord::class),
  )
  private var permissionPromise: Promise? = null

  override fun definition() = ModuleDefinition {
    Name("HealthConnect")

    AsyncFunction("getRequestStatus") { promise: Promise ->
      appContext.backgroundCoroutineScope.launch {
        try {
          promise.resolve(if (hasAllPermissions()) "unnecessary" else "shouldRequest")
        } catch (error: Exception) {
          promise.resolve(if (isAvailable()) "unknown" else "unavailable")
        }
      }
    }

    AsyncFunction("requestPermissions") { promise: Promise ->
      if (!isAvailable()) {
        promise.reject("HEALTH_CONNECT_UNAVAILABLE", unavailableMessage(), null)
        return@AsyncFunction
      }
      if (permissionPromise != null) {
        promise.reject("HEALTH_CONNECT_PERMISSION_REQUEST_IN_PROGRESS", "Health Connect permission request is already open. Complete it in Health Connect before trying again.", null)
        return@AsyncFunction
      }
      appContext.backgroundCoroutineScope.launch {
        try {
          if (hasAllPermissions()) {
            promise.resolve(true)
            return@launch
          }
          val activity = appContext.currentActivity
          if (activity == null) {
            promise.reject("HEALTH_CONNECT_NO_ACTIVITY", "Health Connect permissions require an active app screen. Return to Dofek and try Connect again.", null)
            return@launch
          }
          permissionPromise = promise
          activity.runOnUiThread {
            activity.startActivityForResult(permissionContract.createIntent(activity, requiredPermissions), REQUEST_CODE)
          }
        } catch (error: Exception) {
          promise.reject("HEALTH_CONNECT_PERMISSION_ERROR", "Could not open Health Connect permissions. Update Health Connect and try again.", error)
        }
      }
    }

    Function("hasEverAuthorized") { isAvailable() }
    Function("isAvailable") { isAvailable() }

    AsyncFunction("queryQuantitySamples") { type: String, start: String, end: String, limit: Int, promise: Promise ->
      readAsync(promise, start, end) { client, startTime, endTime ->
        val records = when (type) {
          "HKQuantityTypeIdentifierStepCount" -> client.readRecords(ReadRecordsRequest(StepsRecord::class, TimeRangeFilter.between(startTime, endTime))).records.map { quantity(type, it.metadata.id, it.metadata.dataOrigin.packageName, it.count.toDouble(), "count", it.startTime, it.endTime) }
          "HKQuantityTypeIdentifierDistanceWalkingRunning" -> client.readRecords(ReadRecordsRequest(DistanceRecord::class, TimeRangeFilter.between(startTime, endTime))).records.map { quantity(type, it.metadata.id, it.metadata.dataOrigin.packageName, it.distance.inMeters, "m", it.startTime, it.endTime) }
          "HKQuantityTypeIdentifierFlightsClimbed" -> client.readRecords(ReadRecordsRequest(FloorsClimbedRecord::class, TimeRangeFilter.between(startTime, endTime))).records.map { quantity(type, it.metadata.id, it.metadata.dataOrigin.packageName, it.floors, "count", it.startTime, it.endTime) }
          "HKQuantityTypeIdentifierBodyMass" -> client.readRecords(ReadRecordsRequest(WeightRecord::class, TimeRangeFilter.between(startTime, endTime))).records.map { quantity(type, it.metadata.id, it.metadata.dataOrigin.packageName, it.weight.inKilograms, "kg", it.time, it.time) }
          "HKQuantityTypeIdentifierBodyFatPercentage" -> client.readRecords(ReadRecordsRequest(BodyFatRecord::class, TimeRangeFilter.between(startTime, endTime))).records.map { quantity(type, it.metadata.id, it.metadata.dataOrigin.packageName, it.percentage.value, "%", it.time, it.time) }
          "HKQuantityTypeIdentifierHeartRate" -> client.readRecords(ReadRecordsRequest(HeartRateRecord::class, TimeRangeFilter.between(startTime, endTime))).records.flatMap { record -> record.samples.map { point -> quantity(type, record.metadata.id + ":" + point.time, record.metadata.dataOrigin.packageName, point.beatsPerMinute.toDouble(), "count/min", point.time, point.time) } }
          "HKQuantityTypeIdentifierRestingHeartRate" -> client.readRecords(ReadRecordsRequest(RestingHeartRateRecord::class, TimeRangeFilter.between(startTime, endTime))).records.map { quantity(type, it.metadata.id, it.metadata.dataOrigin.packageName, it.beatsPerMinute.toDouble(), "count/min", it.time, it.time) }
          "HKQuantityTypeIdentifierOxygenSaturation" -> client.readRecords(ReadRecordsRequest(OxygenSaturationRecord::class, TimeRangeFilter.between(startTime, endTime))).records.map { quantity(type, it.metadata.id, it.metadata.dataOrigin.packageName, it.percentage.value, "%", it.time, it.time) }
          "HKQuantityTypeIdentifierRespiratoryRate" -> client.readRecords(ReadRecordsRequest(RespiratoryRateRecord::class, TimeRangeFilter.between(startTime, endTime))).records.map { quantity(type, it.metadata.id, it.metadata.dataOrigin.packageName, it.rate.toDouble(), "count/min", it.time, it.time) }
          "HKQuantityTypeIdentifierVO2Max" -> client.readRecords(ReadRecordsRequest(Vo2MaxRecord::class, TimeRangeFilter.between(startTime, endTime))).records.map { quantity(type, it.metadata.id, it.metadata.dataOrigin.packageName, it.vo2MillilitersPerMinuteKilogram, "mL/min·kg", it.time, it.time) }
          else -> emptyList()
        }
        records.take(if (limit > 0) limit else records.size)
      }
    }

    AsyncFunction("queryDailyStatistics") { type: String, start: String, end: String, promise: Promise ->
      readAsync(promise, start, end) { client, startTime, endTime ->
        val records = when (type) {
          "HKQuantityTypeIdentifierStepCount" -> client.readRecords(ReadRecordsRequest(StepsRecord::class, TimeRangeFilter.between(startTime, endTime))).records.map { it.startTime to it.count.toDouble() }
          "HKQuantityTypeIdentifierDistanceWalkingRunning" -> client.readRecords(ReadRecordsRequest(DistanceRecord::class, TimeRangeFilter.between(startTime, endTime))).records.map { it.startTime to it.distance.inMeters }
          "HKQuantityTypeIdentifierFlightsClimbed" -> client.readRecords(ReadRecordsRequest(FloorsClimbedRecord::class, TimeRangeFilter.between(startTime, endTime))).records.map { it.startTime to it.floors }
          else -> emptyList()
        }
        records.groupBy({ it.first.atZone(java.time.ZoneId.systemDefault()).toLocalDate().toString() }, { it.second }).map { (date, values) -> mapOf("date" to date, "value" to values.sum()) }
      }
    }

    AsyncFunction("queryWorkouts") { start: String, end: String, promise: Promise ->
      readAsync(promise, start, end) { client, startTime, endTime ->
        client.readRecords(ReadRecordsRequest(ExerciseSessionRecord::class, TimeRangeFilter.between(startTime, endTime))).records.map {
          mapOf("uuid" to it.metadata.id, "workoutType" to it.exerciseType.toString(), "startDate" to it.startTime.toString(), "endDate" to it.endTime.toString(), "duration" to Duration.between(it.startTime, it.endTime).seconds.toDouble(), "totalDistance" to null, "sourceName" to "Health Connect", "sourceBundle" to it.metadata.dataOrigin.packageName)
        }
      }
    }

    AsyncFunction("querySleepSamples") { start: String, end: String, promise: Promise ->
      readAsync(promise, start, end) { client, startTime, endTime ->
        client.readRecords(ReadRecordsRequest(SleepSessionRecord::class, TimeRangeFilter.between(startTime, endTime))).records.map {
          mapOf("uuid" to it.metadata.id, "startDate" to it.startTime.toString(), "endDate" to it.endTime.toString(), "value" to "asleep", "sourceName" to "Health Connect")
        }
      }
    }

    AsyncFunction("queryWorkoutRoutes") { _: String, promise: Promise -> promise.resolve(emptyList<Map<String, Any>>()) }
    AsyncFunction("queryAnchoredSamples") { type: String, start: String, promise: Promise -> promise.resolve(mapOf("queryId" to null, "samples" to emptyList<Map<String, Any>>(), "deletedUUIDs" to emptyList<String>())) }
    AsyncFunction("completeAnchoredQuery") { _: String, _: String, _: Boolean, promise: Promise -> promise.resolve(true) }
    AsyncFunction("writeDietarySamples") { _: List<Map<String, Any>>, promise: Promise -> promise.reject("HEALTH_CONNECT_WRITE_NOT_CONFIGURED", "Dofek does not request Health Connect write permissions. Nutrition remains in Dofek.", null) }
    AsyncFunction("deleteDietarySamples") { _: List<String>, promise: Promise -> promise.reject("HEALTH_CONNECT_WRITE_NOT_CONFIGURED", "Dofek does not request Health Connect write permissions. Nutrition remains in Dofek.", null) }
    AsyncFunction("enableBackgroundDelivery") { _: String, promise: Promise -> promise.resolve(false) }
    AsyncFunction("setupBackgroundObservers") { promise: Promise -> promise.resolve(false) }
    AsyncFunction("purgeAccountState") { _: String, promise: Promise -> promise.resolve(true) }

    OnActivityResult { _, payload ->
      if (payload.requestCode != REQUEST_CODE) return@OnActivityResult
      val promise = permissionPromise ?: return@OnActivityResult
      permissionPromise = null
      val granted = permissionContract.parseResult(payload.resultCode, payload.data)
      promise.resolve(granted.containsAll(requiredPermissions))
    }
  }

  private fun isAvailable(): Boolean = HealthConnectClient.getSdkStatus(appContext.reactContext ?: return false) == HealthConnectClient.SDK_AVAILABLE
  private fun unavailableMessage(): String = "Health Connect is unavailable. Install or update Health Connect, then return to Dofek and try again."
  private suspend fun hasAllPermissions(): Boolean = isAvailable() && HealthConnectClient.getOrCreate(appContext.reactContext!!).permissionController.getGrantedPermissions().containsAll(requiredPermissions)
  private fun quantity(type: String, id: String, source: String, value: Double, unit: String, start: Instant, end: Instant): Map<String, Any> = mapOf("type" to type, "value" to value, "unit" to unit, "startDate" to start.toString(), "endDate" to end.toString(), "sourceName" to "Health Connect", "sourceBundle" to source, "uuid" to id)
  private fun readAsync(promise: Promise, start: String, end: String, read: suspend (HealthConnectClient, Instant, Instant) -> Any) {
    if (!isAvailable()) {
      promise.reject("HEALTH_CONNECT_UNAVAILABLE", unavailableMessage(), null)
      return
    }
    val startTime = try { Instant.parse(start) } catch (_: Exception) { promise.reject("HEALTH_CONNECT_INVALID_DATE", "Health Connect received an invalid start date.", null); return }
    val endTime = try { Instant.parse(end) } catch (_: Exception) { promise.reject("HEALTH_CONNECT_INVALID_DATE", "Health Connect received an invalid end date.", null); return }
    appContext.backgroundCoroutineScope.launch {
      try {
        promise.resolve(read(HealthConnectClient.getOrCreate(appContext.reactContext!!), startTime, endTime))
      } catch (error: Exception) {
        promise.reject("HEALTH_CONNECT_QUERY_ERROR", "Health Connect could not read this data. Check its permissions in Android Settings, then try again.", error)
      }
    }
  }

  companion object {
    private const val REQUEST_CODE = 9581
    private val permissionContract: ActivityResultContract<Set<String>, Set<String>> = PermissionController.createRequestPermissionResultContract()
  }
}
