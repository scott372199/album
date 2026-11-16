package family.ourkids.app.data

import android.content.ContentResolver
import android.content.Context
import androidx.exifinterface.media.ExifInterface
import android.media.MediaMetadataRetriever
import android.net.Uri
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Locale

/**
 * Copies selected media into the app-private directory and records only a
 * stable public media path in Room. The original filename and source URI never
 * leave the device.
 */
class MediaImporter(context: Context) {
    private val appContext = context.applicationContext
    private val resolver: ContentResolver = appContext.contentResolver

    fun import(uris: List<Uri>) {
        if (uris.isEmpty()) return
        val database = AppDatabase.get(appContext)
        val media = ArrayList<MediaItem>()
        val imports = File(appContext.filesDir, "imports").apply { mkdirs() }

        for (uri in uris) {
            val mime = resolver.getType(uri).orEmpty()
            if (!mime.startsWith("image/") && !mime.startsWith("video/")) continue
            val (takenAt, timeSource) = takenAt(uri, mime)
            val durationSec = durationSec(uri, mime)
            val digest = MessageDigest.getInstance("SHA-256")
            val id = try {
                val target = File(imports, "pending-${System.nanoTime()}")
                resolver.openInputStream(uri)?.use { input ->
                    FileOutputStream(target).use { output ->
                        val buffer = ByteArray(64 * 1024)
                        var read: Int
                        while (input.read(buffer).also { read = it } >= 0) {
                            if (read == 0) continue
                            digest.update(buffer, 0, read)
                            output.write(buffer, 0, read)
                        }
                    }
                } ?: continue
                val hash = digest.digest().toHex().take(12)
                val mediaId = "md_import_$hash"
                val finalFile = File(imports, mediaId)
                if (target.renameTo(finalFile).not()) {
                    target.copyTo(finalFile, overwrite = true)
                    target.delete()
                }
                mediaId
            } catch (_: Exception) {
                continue
            }
            if (database.mediaDao().byId(id) != null) continue
            media += MediaItem(
                id = id,
                type = if (mime.startsWith("video/")) "video" else "photo",
                takenAt = takenAt,
                durationSec = durationSec,
                timeSource = timeSource,
                uri = "/media/$id"
            )
        }
        if (media.isEmpty()) return
        database.mediaDao().insertAll(media)
        val now = System.currentTimeMillis()
        val startAt = media.minOf { it.takenAt }
        val endAt = media.maxOf { it.takenAt }
        val photoCount = media.count { it.type == "photo" }
        val videoCount = media.count { it.type == "video" }
        val storyId = "st_import_${now}"
        database.storyDao().insertAll(
            listOf(
                Story(
                    id = storyId,
                    title = "新导入的照片",
                    candidates = "新导入的照片|这一批照片|未命名合集",
                    startAt = startAt,
                    endAt = endAt,
                    cover = "https://appassets.androidplatform.net/media/${media.first().id}",
                    photoCount = photoCount,
                    videoCount = videoCount,
                    confidence = "low",
                    status = "draft",
                    batch = 1,
                    aiNote = "本地导入完成 · AI 整理功能尚未接入",
                    deck = "",
                    body = "",
                    pull = ""
                )
            )
        )
        database.storyMediaDao().insertAll(
            media.mapIndexed { index, item -> StoryMedia(storyId, item.id, index, if (index == 0) "lead" else "archive") }
        )
    }

    private fun takenAt(uri: Uri, mime: String): Pair<Long, String> {
        if (mime.startsWith("image/")) {
            val time = runCatching {
                resolver.openInputStream(uri)?.use { input ->
                    val exif = ExifInterface(input)
                    exif.getAttribute(ExifInterface.TAG_DATETIME_ORIGINAL)
                        ?: exif.getAttribute(ExifInterface.TAG_DATETIME)
                }
            }.getOrNull()?.let(::parseExifDate)
            if (time != null) return time to "exif"
        }
        if (mime.startsWith("video/")) {
            val time = runCatching {
                MediaMetadataRetriever().use { retriever ->
                    retriever.setDataSource(appContext, uri)
                    retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DATE)
                }
            }.getOrNull()?.let(::parseVideoDate)
            if (time != null) return time to "exif"
        }
        return System.currentTimeMillis() to "file"
    }

    private fun durationSec(uri: Uri, mime: String): Int {
        if (!mime.startsWith("video/")) return 0
        return runCatching {
            MediaMetadataRetriever().use { retriever ->
                retriever.setDataSource(appContext, uri)
                ((retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L) + 999L) / 1000L
            }.toInt()
        }.getOrDefault(0)
    }

    private fun parseExifDate(raw: String): Long? = runCatching {
        SimpleDateFormat("yyyy:MM:dd HH:mm:ss", Locale.ROOT).apply { isLenient = false }
            .parse(raw)?.time
    }.getOrNull()

    private fun parseVideoDate(raw: String): Long? = runCatching {
        SimpleDateFormat("yyyyMMdd'T'HHmmss", Locale.ROOT).apply { isLenient = false }
            .parse(raw.removeSuffix("Z"))?.time
    }.getOrNull()

    private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }
}
