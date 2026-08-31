package com.dofek.wearmotion

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import com.google.android.gms.wearable.ChannelClient
import com.google.android.gms.wearable.Wearable
import com.google.android.gms.wearable.WearableListenerService
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import io.sentry.Sentry
import java.io.File
import java.io.InputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.zip.GZIPInputStream
import org.json.JSONArray

class WearMotionModule : Module() {
    override fun definition() = ModuleDefinition {
        Name("WearMotion")

        Function("listPendingFiles") {
            WearMotionInbox.list(context)
        }

        AsyncFunction("readFile") { fileName: String ->
            WearMotionInbox.read(context, fileName)
        }

        Function("deleteFile") { fileName: String ->
            WearMotionInbox.delete(context, fileName)
        }
    }
}

/** The phone-side private durable inbox. JavaScript only receives filenames after a complete atomic move. */
private object WearMotionInbox {
    private const val directoryName = "wear-motion-pending"

    fun list(context: Context): List<String> =
        database(context).files().list().map(PendingWearFile::fileName)

    fun persist(context: Context, fileName: String, input: InputStream) {
        require(isSafeFileName(fileName)) { "Invalid pending watch file name: $fileName" }
        val destination = File(directory(context), fileName)
        val temporary = File(destination.parentFile, ".${fileName}.tmp")
        directory(context).mkdirs()
        input.use { source -> temporary.outputStream().use { source.copyTo(it) } }
        try {
            Files.move(
                temporary.toPath(),
                destination.toPath(),
                StandardCopyOption.ATOMIC_MOVE,
                StandardCopyOption.REPLACE_EXISTING,
            )
        } catch (error: Exception) {
            Sentry.captureException(error)
            Files.move(temporary.toPath(), destination.toPath(), StandardCopyOption.REPLACE_EXISTING)
        }
        database(context).files().upsert(PendingWearFile(fileName, destination.absolutePath))
    }

    fun read(context: Context, fileName: String): List<Map<String, Any>> {
        require(isSafeFileName(fileName)) { "Invalid pending watch file name: $fileName" }
        val record = database(context).files().get(fileName)
            ?: throw IllegalArgumentException("Pending Wear file not found: $fileName")
        val payload = GZIPInputStream(File(record.path).inputStream()).bufferedReader().use { it.readText() }
        val samples = JSONArray(payload)
        return List(samples.length()) { index ->
            samples.getJSONObject(index).let { sample ->
                buildMap {
                    put("timestamp", sample.getString("timestamp"))
                    put("x", sample.getDouble("x"))
                    put("y", sample.getDouble("y"))
                    put("z", sample.getDouble("z"))
                    listOf("gyroscopeX", "gyroscopeY", "gyroscopeZ").forEach { key ->
                        if (sample.has(key) && !sample.isNull(key)) put(key, sample.getDouble(key))
                    }
                }
            }
        }
    }

    fun delete(context: Context, fileName: String) {
        require(isSafeFileName(fileName)) { "Invalid pending watch file name: $fileName" }
        database(context).files().get(fileName)?.let { File(it.path).delete() }
        database(context).files().delete(fileName)
    }

    private fun directory(context: Context) = File(context.filesDir, directoryName)

    private fun database(context: Context): WearMotionDatabase =
        Room.databaseBuilder(context.applicationContext, WearMotionDatabase::class.java, "wear-motion.db").build()

    private fun isSafeFileName(fileName: String): Boolean =
        fileName.startsWith("wear-motion-") &&
            fileName.endsWith(".json.gz") &&
            !fileName.contains("..") &&
            !fileName.contains('/') &&
            !fileName.contains('\\')
}

@Entity(tableName = "pending_wear_file")
private data class PendingWearFile(
    @androidx.room.PrimaryKey val fileName: String,
    val path: String,
)

@Dao
private interface PendingWearFileDao {
    @Query("SELECT * FROM pending_wear_file ORDER BY fileName")
    fun list(): List<PendingWearFile>

    @Query("SELECT * FROM pending_wear_file WHERE fileName = :fileName")
    fun get(fileName: String): PendingWearFile?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun upsert(file: PendingWearFile)

    @Query("DELETE FROM pending_wear_file WHERE fileName = :fileName")
    fun delete(fileName: String)
}

@Database(entities = [PendingWearFile::class], version = 1, exportSchema = false)
private abstract class WearMotionDatabase : RoomDatabase() {
    abstract fun files(): PendingWearFileDao
}

/** Receives Data Layer streams independently of the Expo module lifecycle. */
class WearMotionChannelService : WearableListenerService() {
    override fun onChannelOpened(channel: ChannelClient.Channel) {
        super.onChannelOpened(channel)
        val fileName = channel.path.substringAfterLast('/')
        Wearable.getChannelClient(this).getInputStream(channel)
            .addOnSuccessListener { input ->
                try {
                    WearMotionInbox.persist(this, fileName, input)
                } catch (error: Exception) {
                    Sentry.captureException(error)
                }
            }
            .addOnFailureListener(Sentry::captureException)
    }
}
