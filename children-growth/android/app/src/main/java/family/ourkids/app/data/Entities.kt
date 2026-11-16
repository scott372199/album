package family.ourkids.app.data

import androidx.room.Entity
import androidx.room.PrimaryKey

/** 家庭成员。人工只需要填关系 + 3 张参考照，其余由人脸聚类自动累积。 */
@Entity(tableName = "people")
data class Person(
    @PrimaryKey val id: String,
    val relation: String,          // 爸爸 / 妈妈 / 爷爷 / 奶奶 / 外公 / 外婆
    val name: String,
    val appearCount: Int = 0,
    val refPhoto: String = ""
)

/** 一张照片或一段视频。时间来源要记清楚，EXIF 缺失时才能被发现。 */
@Entity(tableName = "media")
data class MediaItem(
    @PrimaryKey val id: String,
    val type: String,              // photo | video
    val takenAt: Long,             // epoch millis
    val durationSec: Int = 0,
    val timeSource: String = "exif",   // exif | file | manual
    val qualityScore: Float = 0f,
    val sceneTags: String = "",        // 逗号分隔
    val uri: String = ""
)

/** 一个故事集。draft 状态就是「上传确认页」里待处理的那一行。 */
@Entity(tableName = "stories")
data class Story(
    @PrimaryKey val id: String,
    val title: String,
    val candidates: String,        // 三个候选，竖线分隔
    val startAt: Long,
    val endAt: Long,
    val type: String = "event",    // event | series
    val ageFromMonth: Int = 0,
    val ageToMonth: Int = 0,
    val cover: String = "",
    val people: String = "",       // 逗号分隔
    val scenes: String = "",       // 逗号分隔
    val photoCount: Int = 0,
    val videoCount: Int = 0,
    val confidence: String = "high",   // high | mid | low
    val status: String = "draft",      // draft | published
    val batch: Int = 0,                // 1 = 本次上传批次，0 = 往年已在相册里的
    val aiNote: String = "",           // AI 给自己这一条写的说明，直接显示在标题上方
    val deck: String = "",
    val body: String = "",
    val pull: String = ""
)

/** 故事与照片的关联，orderNo 决定内页里的顺序，role 决定它出现在哪一段。 */
@Entity(tableName = "story_media", primaryKeys = ["storyId", "mediaId"])
data class StoryMedia(
    val storyId: String,
    val mediaId: String,
    val orderNo: Int = 0,
    val role: String = "inline"    // cover | lead | inline | archive
)
