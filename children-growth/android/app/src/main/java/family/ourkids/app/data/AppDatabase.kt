package family.ourkids.app.data

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import java.time.LocalDate
import java.time.ZoneId

@Database(
    entities = [Person::class, MediaItem::class, Story::class, StoryMedia::class],
    version = 1,
    exportSchema = false
)
abstract class AppDatabase : RoomDatabase() {

    abstract fun personDao(): PersonDao
    abstract fun mediaDao(): MediaDao
    abstract fun storyDao(): StoryDao
    abstract fun storyMediaDao(): StoryMediaDao

    companion object {
        @Volatile
        private var instance: AppDatabase? = null

        /**
         * 首次拿到实例时建库并灌入示例数据。
         * 只允许在后台线程调用（shouldInterceptRequest 本来就在后台线程）。
         */
        fun get(context: Context): AppDatabase =
            instance ?: synchronized(this) {
                instance ?: Room.databaseBuilder(
                    context.applicationContext,
                    AppDatabase::class.java,
                    "ourkids.db"
                )
                    .fallbackToDestructiveMigration()
                    .build()
                    .also {
                        Seed.ensure(it)
                        it.storyDao().normalizeLegacyImportNotes()
                        instance = it
                    }
            }
    }
}

/**
 * 示例数据：一次「上传了 286 张照片 + 8 段视频，AI 生成 18 个草稿」的完整现场。
 * 数字与「上传确认页」上写的一致，页面换成读数据库之后不会自相矛盾。
 */
object Seed {

    private val SCENES = listOf("家里", "小区", "公园", "餐厅", "路上", "幼儿园")

    /** 日期字符串 → epoch millis（本地时区当天零点）。嵌套的 Tpl 也要用，所以不设 private。 */
    internal fun d(s: String): Long =
        LocalDate.parse(s).atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli()

    fun ensure(db: AppDatabase) {
        if (db.storyDao().count() > 0) return

        /* ---------- 人物：人工只填关系，出镜次数由聚类累积 ---------- */
        db.personDao().insertAll(
            listOf(
                Person("p_mom", "妈妈", "妈妈", 58, "https://picsum.photos/seed/p2/600/600"),
                Person("p_dad", "爸爸", "爸爸", 41, "https://picsum.photos/seed/p1/600/600"),
                Person("p_nai", "奶奶", "奶奶", 34, "https://picsum.photos/seed/p4/600/600"),
                Person("p_wai", "外婆", "外婆", 29, "https://picsum.photos/seed/p6/600/600"),
                Person("p_ye", "爷爷", "爷爷", 22, "https://picsum.photos/seed/p3/600/600"),
                Person("p_gong", "外公", "外公", 17, "https://picsum.photos/seed/p5/600/600")
            )
        )

        /* ---------- 媒体：286 张 + 8 段 ---------- */
        db.mediaDao().insertAll(demoMedia())

        /* ---------- 故事：4 条往年已发布 + 本次批次 18 条 ---------- */
        db.storyDao().insertAll(oldPublished() + batchStories())

        /* ---------- 一条故事的媒体关系，演示 story_media 的 role / orderNo ---------- */
        db.storyMediaDao().insertAll(
            listOf(
                StoryMedia("st_walk", "md_001", 0, "lead"),
                StoryMedia("st_walk", "md_002", 1, "inline"),
                StoryMedia("st_walk", "vd_001", 2, "inline")
            )
        )
    }

    /* ================= 媒体 ================= */

    private fun demoMedia(): List<MediaItem> {
        val birth = LocalDate.of(2019, 4, 12)
        val out = ArrayList<MediaItem>(294)

        // 照片：日期按孩子的月龄铺开，第 1、2 张给「走路这件事」用
        for (i in 1..286) {
            val day = birth.plusDays((i * 41L) % 2550)
            out += MediaItem(
                id = "md_%03d".format(i),
                type = "photo",
                takenAt = d(day.toString()),
                timeSource = if (i % 19 == 0) "file" else "exif",   // 少数几张没有 EXIF，用来演示「时间存疑」
                sceneTags = SCENES[i % SCENES.size],
                uri = when (i) {
                    1 -> "https://picsum.photos/seed/wk01/1600/1000"
                    2 -> "https://picsum.photos/seed/wk03/800/1000"
                    else -> "https://picsum.photos/seed/mx%03d/1200/800".format(i)
                }
            )
        }

        // 视频：抽过帧，时长已知
        for (i in 1..8) {
            val day = birth.plusDays((i * 173L) % 2300)
            out += MediaItem(
                id = "vd_%03d".format(i),
                type = "video",
                takenAt = d(day.toString()),
                durationSec = 12 + i * 6,
                sceneTags = SCENES[i % SCENES.size],
                uri = "https://picsum.photos/seed/vd%03d/1600/900".format(i)
            )
        }
        return out
    }

    /* ================= 往年已发布（batch = 0） ================= */

    private fun oldPublished(): List<Story> = listOf(
        Story(
            id = "st_window", title = "每天早上的那扇窗", candidates = "每天早上的那扇窗",
            startAt = d("2020-04-02"), endAt = d("2022-12-30"), type = "series",
            ageFromMonth = 11, ageToMonth = 44,
            cover = "https://picsum.photos/seed/st02/300/380",
            people = "妈妈,外婆", scenes = "家里",
            photoCount = 58, confidence = "high", status = "published",
            deck = "同一扇窗，三年。", pull = "光每天都落在同一个位置。"
        ),
        Story(
            id = "st_sea", title = "第一次看见海", candidates = "第一次看见海",
            startAt = d("2019-08-10"), endAt = d("2019-08-13"),
            ageFromMonth = 4, ageToMonth = 4,
            cover = "https://picsum.photos/seed/st01/300/380",
            people = "爸爸,妈妈", scenes = "海边",
            photoCount = 24, confidence = "high", status = "published",
            deck = "他站在沙滩上不肯往前走。", pull = "浪打湿鞋，他才笑。"
        ),
        Story(
            id = "st_bike", title = "学会骑车的那年夏天", candidates = "学会骑车的那年夏天",
            startAt = d("2022-06-01"), endAt = d("2022-08-20"),
            ageFromMonth = 38, ageToMonth = 40,
            cover = "https://picsum.photos/seed/gs02/300/380",
            people = "爸爸", scenes = "小区",
            photoCount = 38, confidence = "high", status = "published",
            deck = "摔了两次，第三次自己骑出去了。", pull = "那天大部分照片是糊的。"
        ),
        Story(
            id = "st_fever", title = "发高烧那三天", candidates = "发高烧那三天",
            startAt = d("2021-07-20"), endAt = d("2021-07-23"),
            ageFromMonth = 27, ageToMonth = 27,
            cover = "https://picsum.photos/seed/st08/300/380",
            people = "爸爸,妈妈", scenes = "医院",
            photoCount = 9, confidence = "high", status = "published",
            deck = "半夜十一点，急诊走廊上全是人。", pull = "第二天早上他退烧了。"
        )
    )

    /* ================= 本次上传批次（batch = 1，共 18 条） ================= */

    private fun batchStories(): List<Story> = sixDetailed() + twelveTemplates().map { it.toStory() }

    /** 六条写全了的草稿：标题候选、正文、旁白都有，用来演示「故事内页」能读到什么。 */
    private fun sixDetailed(): List<Story> = listOf(
        Story(
            id = "st_walk", title = "走路这件事",
            candidates = "走路这件事|学会走路的那几个月|2021 年的春天",
            startAt = d("2021-03-14"), endAt = d("2021-11-02"), type = "series",
            ageFromMonth = 23, ageToMonth = 31,
            cover = "https://picsum.photos/seed/rv01/300/380",
            people = "妈妈,外婆", scenes = "家里,小区",
            photoCount = 23, videoCount = 1, confidence = "high", status = "draft", batch = 1,
            aiNote = "AI 建议标题 · 三个候选，选一个或自己改",
            deck = "他第一次松开手，是三月的一个下午。",
            body = "三月的那个下午，他扶着沙发站起来，手心全是汗。我们都没出声，怕一说话他就坐回去。",
            pull = "他走得很慢，我们跟得更慢。"
        ),
        Story(
            id = "st_plaza", title = "楼下的小广场",
            candidates = "楼下的小广场|每天下午的那个广场|2021—2022 的下午",
            startAt = d("2021-04-05"), endAt = d("2022-10-21"), type = "series",
            ageFromMonth = 24, ageToMonth = 42,
            cover = "https://picsum.photos/seed/rv02/300/380",
            people = "外婆", scenes = "公园",
            photoCount = 41, confidence = "high", status = "draft", batch = 1,
            aiNote = "AI 建议标题 · 检测到跨年重复场景，建议设为「系列」",
            deck = "每天下午四点，他都拉着外婆往楼下走。",
            pull = "广场上什么都有，他只想跑。"
        ),
        Story(
            id = "st_newyear", title = "过年回老家",
            candidates = "过年回老家|2021 年春节|回爷爷奶奶家",
            startAt = d("2021-02-11"), endAt = d("2021-02-16"),
            ageFromMonth = 22, ageToMonth = 22,
            cover = "https://picsum.photos/seed/rv03/300/380",
            people = "爷爷,奶奶", scenes = "节日",
            photoCount = 34, confidence = "mid", status = "draft", batch = 1,
            aiNote = "AI 建议标题 · 三张候选都不太满意，可以直接写",
            deck = "第一次回老家过年，他被鞭炮吓得躲在奶奶怀里。",
            pull = "他记住了饺子的味道。"
        ),
        Story(
            id = "st_er", title = "2021 年 7 月照片",
            candidates = "2021 年 7 月照片|未命名合集|一组照片",
            startAt = d("2021-07-22"), endAt = d("2021-07-24"),
            ageFromMonth = 27, ageToMonth = 27,
            cover = "https://picsum.photos/seed/rv04/300/380",
            people = "爸爸,妈妈", scenes = "医院",
            photoCount = 9, confidence = "low", status = "draft", batch = 1,
            aiNote = "AI 拿不准 · 场景和人物都识别到了，但说不出这是什么事",
            deck = "", pull = ""
        ),
        Story(
            id = "st_plane", title = "第一次坐飞机",
            candidates = "第一次坐飞机|2021 年国庆的三天|带他出门",
            startAt = d("2021-10-03"), endAt = d("2021-10-05"),
            ageFromMonth = 30, ageToMonth = 30,
            cover = "https://picsum.photos/seed/rv05/300/380",
            people = "爸爸,妈妈", scenes = "旅行",
            photoCount = 21, videoCount = 2, confidence = "high", status = "draft", batch = 1,
            aiNote = "AI 建议标题 · 含视频，已抽帧 12 张",
            deck = "起飞时他睡着了，降落时他醒了。",
            pull = "他全程都在看窗外。"
        ),
        Story(
            id = "st_bath", title = "洗澡时的照片",
            candidates = "洗澡这件事（续）|洗澡时的照片|2022 年夏天",
            startAt = d("2022-06-08"), endAt = d("2022-08-30"), type = "series",
            ageFromMonth = 38, ageToMonth = 40,
            cover = "https://picsum.photos/seed/rv06/300/380",
            people = "爸爸", scenes = "家里",
            photoCount = 26, confidence = "mid", status = "draft", batch = 1,
            aiNote = "AI 建议标题 · 与已有的「洗澡这件事」可能重复，稍后可合并",
            deck = "每次洗澡都要把水泼到镜子上。",
            pull = "他管这叫下雨。"
        )
    )

    /** 剩下 12 条只填必要字段，模拟「AI 批量产出、还没人看过」的那一批。 */
    private fun twelveTemplates(): List<Tpl> = listOf(
        Tpl("bt_eat", "第一次自己吃饭", "第一次自己吃饭|非要自己拿勺子的那几个月", "2019-11-03", "2020-02-18", 6, 10, "bt01", "爸爸,妈妈", "家里", 18, 1),
        Tpl("bt_cat", "楼下的猫", "楼下的猫|他追了半年的那只猫", "2020-05-02", "2021-09-30", 12, 29, "bt02", "外婆", "小区", 27, 0, type = "series"),
        Tpl("bt_talk", "学说话的录音", "学说话的录音|他把「西瓜」说成「西花」", "2020-03-11", "2021-03-02", 11, 22, "bt03", "妈妈", "家里", 14, 3),
        Tpl("bt_kg", "幼儿园第一天", "幼儿园第一天|第一天送他进班", "2022-09-01", "2022-09-01", 41, 41, "bt04", "爸爸,妈妈", "幼儿园", 22, 0),
        Tpl("bt_hair", "剪头发", "剪头发|每次剪头都要人按住", "2020-08-15", "2022-07-09", 16, 39, "bt05", "爷爷", "家里", 11, 0, type = "series"),
        Tpl("bt_cake", "生日蛋糕", "生日蛋糕|四个生日|每年四月的那张", "2020-04-12", "2023-04-12", 12, 48, "bt06", "爷爷,奶奶", "家里", 36, 2, type = "series"),
        Tpl("bt_shot", "打疫苗", "打疫苗|每次都在同一个走廊", "2021-01-20", "2022-03-15", 21, 35, "bt07", "爸爸,奶奶", "医院", 7, 0, conf = "mid"),
        Tpl("bt_mart", "逛超市", "逛超市|推小推车的两年", "2021-06-05", "2022-11-20", 26, 43, "bt08", "外婆", "超市", 19, 0, conf = "mid", type = "series"),
        Tpl("bt_rain", "雨天不出门", "雨天不出门|未命名合集", "2023-07-08", "2023-07-09", 51, 51, "bt09", "妈妈", "家里", 6, 0, conf = "low"),
        Tpl("bt_snow", "第一次看见雪", "第一次看见雪", "2020-01-06", "2020-01-07", 9, 9, "bt10", "爸爸", "小区", 25, 1, status = "published"),
        Tpl("bt_swim", "学游泳", "学游泳|去年夏天的泳池", "2023-07-15", "2023-08-26", 51, 52, "bt11", "爸爸,妈妈", "泳池", 31, 4, status = "published"),
        Tpl("bt_move", "搬新家", "搬新家|空房子的那三天", "2021-05-01", "2021-05-03", 25, 25, "bt12", "爸爸,妈妈", "家里", 42, 0, status = "published")
    )

    private data class Tpl(
        val id: String, val title: String, val cands: String,
        val from: String, val to: String,
        val ageFrom: Int, val ageTo: Int, val seed: String,
        val people: String, val scenes: String,
        val photos: Int, val videos: Int,
        val conf: String = "high",
        val status: String = "draft",
        val type: String = "event"
    ) {
        fun toStory(): Story = Story(
            id = id, title = title, candidates = cands,
            startAt = Seed.d(from), endAt = Seed.d(to), type = type,
            ageFromMonth = ageFrom, ageToMonth = ageTo,
            cover = "https://picsum.photos/seed/$seed/300/380",
            people = people, scenes = scenes,
            photoCount = photos, videoCount = videos,
            confidence = conf, status = status, batch = 1
        )
    }
}
