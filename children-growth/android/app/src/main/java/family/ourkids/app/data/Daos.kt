package family.ourkids.app.data

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query

@Dao
interface PersonDao {
    @Query("SELECT * FROM people ORDER BY appearCount DESC")
    fun all(): List<Person>

    @Query("SELECT COUNT(*) FROM people")
    fun count(): Int

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun insertAll(list: List<Person>)
}

@Dao
interface MediaDao {
    @Query("SELECT * FROM media WHERE id = :id")
    fun byId(id: String): MediaItem?

    @Query("SELECT * FROM media WHERE id LIKE 'md_import_%' AND type = 'photo' ORDER BY takenAt DESC")
    fun importedPhotos(): List<MediaItem>

    @Query("SELECT COUNT(*) FROM media WHERE type = 'photo'")
    fun photoCount(): Int

    @Query("SELECT COUNT(*) FROM media WHERE type = 'video'")
    fun videoCount(): Int

    @Query("SELECT COUNT(*) FROM media WHERE timeSource != 'exif'")
    fun doubtfulTimeCount(): Int

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun insertAll(list: List<MediaItem>)
}

@Dao
interface StoryDao {
    @Query("SELECT * FROM stories WHERE status = 'draft' ORDER BY startAt DESC")
    fun drafts(): List<Story>

    /** 本次上传批次的全部故事（含已经接受过的），上传确认页要看到完整的一批。 */
    @Query("SELECT * FROM stories WHERE batch = 1 ORDER BY startAt DESC")
    fun batchAll(): List<Story>

    @Query("SELECT COUNT(*) FROM stories WHERE batch = 1")
    fun batchCount(): Int

    @Query("SELECT * FROM stories WHERE status = 'published' ORDER BY startAt DESC")
    fun published(): List<Story>

    @Query("SELECT * FROM stories WHERE status = :status ORDER BY startAt DESC")
    fun byStatus(status: String): List<Story>

    @Query("SELECT * FROM stories WHERE id = :id")
    fun byId(id: String): Story?

    @Query("SELECT * FROM stories WHERE startAt <= :dayEnd AND endAt >= :dayStart")
    fun onDay(dayStart: Long, dayEnd: Long): List<Story>

    @Query("UPDATE stories SET status = 'published' WHERE id = :id")
    fun accept(id: String)

    @Query("UPDATE stories SET title = :title WHERE id = :id")
    fun rename(id: String, title: String)

    @Query("UPDATE stories SET status = 'merged' WHERE id = :id")
    fun markMerged(id: String)

    @Query("UPDATE stories SET photoCount = :photoCount, videoCount = :videoCount WHERE id = :id")
    fun updateCounts(id: String, photoCount: Int, videoCount: Int)

    @Query("UPDATE stories SET aiNote = '本地导入完成 · 自动整理尚未接入' WHERE aiNote = 'AI 还没有整理这批照片，请稍后确认'")
    fun normalizeLegacyImportNotes(): Int

    @Query("SELECT COUNT(*) FROM stories")
    fun count(): Int

    @Query("SELECT COUNT(*) FROM stories WHERE status = 'draft'")
    fun draftCount(): Int

    @Query("SELECT COUNT(*) FROM stories WHERE status = 'draft' AND confidence = 'high'")
    fun highConfidenceDraftCount(): Int

    /** 本次批次里还等着确认的高置信度草稿——「一键接受」按钮上显示的就是这个数。 */
    @Query("SELECT COUNT(*) FROM stories WHERE batch = 1 AND status = 'draft' AND confidence = 'high'")
    fun highDraftInBatch(): Int

    @Query("UPDATE stories SET status = 'published' WHERE status = 'draft' AND confidence = 'high'")
    fun acceptAllHighConfidence(): Int

    @Query("UPDATE stories SET status = 'published' WHERE batch = 1 AND status = 'draft' AND confidence = 'high'")
    fun acceptAllHighInBatch(): Int

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun insertAll(list: List<Story>)
}

@Dao
interface StoryMediaDao {
    @Query("SELECT * FROM story_media WHERE storyId = :storyId ORDER BY orderNo")
    fun of(storyId: String): List<StoryMedia>

    @Query("DELETE FROM story_media WHERE storyId = :storyId AND mediaId = :mediaId")
    fun delete(storyId: String, mediaId: String)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun insertAll(list: List<StoryMedia>)
}
