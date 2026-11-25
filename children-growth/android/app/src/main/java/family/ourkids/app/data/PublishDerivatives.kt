package family.ourkids.app.data

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import androidx.exifinterface.media.ExifInterface
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest

/** Builds metadata-free JPEG display derivatives from app-private imports. */
class PublishDerivatives(context: Context) {
    private val appContext = context.applicationContext
    private val imports = File(appContext.filesDir, "imports")
    private val output = File(appContext.filesDir, "publish").apply { mkdirs() }

    data class Item(val id: String, val file: File, val sha256: String)

    fun all(): List<Item> = AppDatabase.get(appContext).mediaDao().importedPhotos().mapNotNull(::ensure)

    fun file(id: String): File? {
        if (!id.matches(Regex("md_import_[a-f0-9]{12}"))) return null
        val existing = File(output, "$id.jpg")
        if (existing.isFile) return existing
        val media = AppDatabase.get(appContext).mediaDao().byId(id) ?: return null
        return ensure(media)?.file
    }

    private fun ensure(media: MediaItem): Item? {
        val source = File(imports, media.id)
        if (!source.isFile) return null
        val target = File(output, "${media.id}.jpg")
        if (!target.isFile && !encode(source, target)) return null
        return Item(media.id, target, sha256(target))
    }

    private fun encode(source: File, target: File): Boolean = runCatching {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(source.absolutePath, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return false
        var sample = 1
        while (maxOf(bounds.outWidth / sample, bounds.outHeight / sample) > 2560) sample *= 2
        val bitmap = BitmapFactory.decodeFile(source.absolutePath, BitmapFactory.Options().apply { inSampleSize = sample })
            ?: return false
        val orientation = runCatching { ExifInterface(source).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL) }
            .getOrDefault(ExifInterface.ORIENTATION_NORMAL)
        val matrix = Matrix().apply {
            when (orientation) {
                ExifInterface.ORIENTATION_ROTATE_90 -> postRotate(90f)
                ExifInterface.ORIENTATION_ROTATE_180 -> postRotate(180f)
                ExifInterface.ORIENTATION_ROTATE_270 -> postRotate(270f)
                ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> postScale(-1f, 1f)
                ExifInterface.ORIENTATION_FLIP_VERTICAL -> postScale(1f, -1f)
            }
        }
        val oriented = if (matrix.isIdentity) bitmap else Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
        val scale = minOf(1f, 2048f / maxOf(oriented.width, oriented.height))
        val display = if (scale < 1f) Bitmap.createScaledBitmap(oriented, (oriented.width * scale).toInt(), (oriented.height * scale).toInt(), true) else oriented
        val temp = File(output, ".${mediaSafeName(source)}-${System.nanoTime()}.tmp")
        FileOutputStream(temp).use { stream -> check(display.compress(Bitmap.CompressFormat.JPEG, 86, stream)) }
        check(temp.renameTo(target) || run { temp.copyTo(target, overwrite = true); temp.delete(); true })
        if (display !== oriented) display.recycle()
        if (oriented !== bitmap) oriented.recycle()
        bitmap.recycle()
        true
    }.getOrDefault(false)

    private fun mediaSafeName(file: File) = file.name.replace(Regex("[^a-zA-Z0-9_-]"), "_")

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
}
