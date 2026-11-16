package family.ourkids.app.data

import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest

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
                takenAt = System.currentTimeMillis(),
                timeSource = "file",
                uri = "/media/$id"
            )
        }
        if (media.isEmpty()) return
        database.mediaDao().insertAll(media)
        val now = System.currentTimeMillis()
        val photoCount = media.count { it.type == "photo" }
        val videoCount = media.count { it.type == "video" }
        database.storyDao().insertAll(
            listOf(
                Story(
                    id = "st_import_${now}",
                    title = "新导入的照片",
                    candidates = "新导入的照片|这一批照片|未命名合集",
                    startAt = now,
                    endAt = now,
                    cover = media.first().uri,
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
    }

    private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }
}
