package family.ourkids.app.net

import android.content.Context
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import family.ourkids.app.data.AppDatabase
import family.ourkids.app.data.Story
import family.ourkids.app.data.StoryMedia
import java.io.ByteArrayInputStream
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * 把 Room 里的数据以本地 HTTP 接口的形式暴露给 WebView。
 *
 * 页面里直接 fetch('https://appassets.androidplatform.net/api/drafts') 即可，
 * 不用 JS Bridge，前端和浏览器里写代码的方式保持一致。
 */
class ApiServer(context: Context) {

    private val appContext = context.applicationContext
    private fun db() = AppDatabase.get(appContext)

    fun handle(request: WebResourceRequest): WebResourceResponse {
        val path = request.url.path ?: "/"
        val method = (request.method ?: "GET").uppercase()

        return try {
            when {
                path == "/api/bootstrap" && method == "GET" -> ok(bootstrap())

                path == "/api/drafts" && method == "GET" -> ok(drafts())

                path == "/api/stories" && method == "GET" -> ok(stories("published"))

                path.startsWith("/api/stories/") && method == "GET" ->
                    path.removePrefix("/api/stories/").let { id ->
                        val s = db().storyDao().byId(id)
                        if (s == null) error(404, "story not found") else ok(storyJson(s, true))
                    }

                path.startsWith("/api/drafts/") && path.endsWith("/accept") && method == "POST" -> {
                    val id = path.removePrefix("/api/drafts/").removeSuffix("/accept")
                    db().storyDao().accept(id)
                    ok("""{"ok":true,"id":"${esc(id)}"}""")
                }

                path == "/api/drafts/accept-all" && method == "POST" -> {
                    val n = db().storyDao().acceptAllHighInBatch()
                    ok("""{"ok":true,"accepted":$n}""")
                }

                // 改名：shouldInterceptRequest 拿不到请求体，所以标题走 query 参数
                path.startsWith("/api/drafts/") && path.endsWith("/rename") && method == "POST" -> {
                    val id = path.removePrefix("/api/drafts/").removeSuffix("/rename")
                    val title = request.url.getQueryParameter("title")?.trim().orEmpty()
                    if (title.isEmpty()) {
                        error(400, "title required")
                    } else {
                        db().storyDao().rename(id, title)
                        ok("""{"ok":true,"id":"${esc(id)}","title":"${esc(title)}"}""")
                    }
                }

                path.startsWith("/api/drafts/") && path.endsWith("/merge") && method == "POST" -> {
                    val id = path.removePrefix("/api/drafts/").removeSuffix("/merge")
                    val into = request.url.getQueryParameter("into")?.trim().orEmpty()
                    merge(id, into)
                }

                path == "/api/people" && method == "GET" -> ok(people())

                path == "/api/today" && method == "GET" -> ok(today())

                else -> error(404, "no route: $method $path")
            }
        } catch (t: Throwable) {
            error(500, t.message ?: "internal error")
        }
    }

    /* ---------------- 各接口 ---------------- */

    private fun merge(sourceId: String, targetId: String): WebResourceResponse {
        if (sourceId.isBlank() || targetId.isBlank()) return error(400, "into required")
        if (sourceId == targetId) return error(400, "cannot merge into itself")
        val database = db()
        val source = database.storyDao().byId(sourceId) ?: return error(404, "source story not found")
        val target = database.storyDao().byId(targetId) ?: return error(404, "target story not found")
        if (target.status == "merged") return error(409, "target story is merged")
        if (source.status == "merged") return ok("""{"ok":true,"id":"${esc(sourceId)}","into":"${esc(targetId)}","moved":0}""")

        val sourceMedia = database.storyMediaDao().of(sourceId)
        val targetMedia = database.storyMediaDao().of(targetId)
        val offset = (targetMedia.maxOfOrNull { it.orderNo } ?: -1) + 1
        database.runInTransaction {
            sourceMedia.forEachIndexed { index, item ->
                database.storyMediaDao().delete(sourceId, item.mediaId)
                database.storyMediaDao().insertAll(listOf(StoryMedia(targetId, item.mediaId, offset + index, item.role)))
            }
            database.storyDao().updateCounts(
                targetId,
                target.photoCount + source.photoCount,
                target.videoCount + source.videoCount
            )
            database.storyDao().markMerged(sourceId)
        }
        return ok("""{"ok":true,"id":"${esc(sourceId)}","into":"${esc(targetId)}","moved":${sourceMedia.size}}""")
    }

    private fun bootstrap(): String {
        val storyDao = db().storyDao()
        val mediaDao = db().mediaDao()
        return buildString {
            append("{")
            append("\"child\":{\"name\":\"我们的孩子\",\"birthday\":\"2019-04-12\",\"years\":[2019,2026]},")
            append("\"stats\":{")
            append("\"photos\":").append(mediaDao.photoCount()).append(',')
            append("\"videos\":").append(mediaDao.videoCount()).append(',')
            append("\"people\":").append(db().personDao().count()).append(',')
            append("\"batchStories\":").append(storyDao.batchCount()).append(',')
            append("\"pendingDrafts\":").append(storyDao.draftCount()).append(',')
            append("\"highConfidence\":").append(storyDao.highDraftInBatch()).append(',')
            append("\"stories\":").append(storyDao.count()).append(',')
            append("\"doubtfulTime\":").append(mediaDao.doubtfulTimeCount())
            append("},")
            append("\"people\":").append(peopleArray())
            append("}")
        }
    }

    /** 上传确认页：本次批次的全部故事，已确认的也在里面（前端据此渲染 done 态）。 */
    private fun drafts(): String {
        val list = db().storyDao().batchAll()
        return buildString {
            append("{\"total\":").append(list.size)
            append(",\"highConfidence\":").append(db().storyDao().highDraftInBatch())
            append(",\"items\":[")
            list.forEachIndexed { i, s ->
                if (i > 0) append(',')
                append(storyJson(s, false))
            }
            append("]}")
        }
    }

    private fun stories(status: String): String {
        val list = db().storyDao().byStatus(status)
        return buildString {
            append("{\"total\":").append(list.size).append(",\"items\":[")
            list.forEachIndexed { i, s ->
                if (i > 0) append(',')
                append(storyJson(s, false))
            }
            append("]}")
        }
    }

    private fun people(): String = """{"items":${peopleArray()}}"""

    private fun peopleArray(): String = buildString {
        append("[")
        db().personDao().all().forEachIndexed { i, p ->
            if (i > 0) append(',')
            append("{\"id\":\"${esc(p.id)}\",\"relation\":\"${esc(p.relation)}\",")
            append("\"name\":\"${esc(p.name)}\",\"appearCount\":${p.appearCount},")
            append("\"refPhoto\":\"${esc(p.refPhoto)}\"}")
        }
        append("]")
    }

    /** 今天对应的「N 年前的今天」：取覆盖今天的已发布故事，没有就取最近的一条。 */
    private fun today(): String {
        val zone = ZoneId.systemDefault()
        val start = LocalDate.now().atStartOfDay(zone).toInstant().toEpochMilli()
        val end = start + 86_400_000L
        val storyDao = db().storyDao()
        val hit = storyDao.onDay(start, end).firstOrNull { it.status == "published" }
            ?: storyDao.published().firstOrNull()
            ?: return """{"item":null}"""
        return """{"item":${storyJson(hit, true)}}"""
    }

    /* ---------------- 序列化 ---------------- */

    private fun storyJson(s: Story, withMedia: Boolean): String = buildString {
        append("{")
        append("\"id\":\"${esc(s.id)}\",")
        append("\"title\":\"${esc(s.title)}\",")
        append("\"candidates\":[")
        s.candidates.split('|').filter { it.isNotBlank() }.forEachIndexed { i, c ->
            if (i > 0) append(',')
            append("\"${esc(c)}\"")
        }
        append("],")
        append("\"startAt\":${s.startAt},\"endAt\":${s.endAt},")
        append("\"range\":\"${range(s.startAt, s.endAt)}\",")
        append("\"type\":\"${esc(s.type)}\",")
        append("\"age\":{\"fromMonth\":${s.ageFromMonth},\"toMonth\":${s.ageToMonth}},")
        append("\"cover\":\"${esc(s.cover)}\",")
        append("\"people\":${list(s.people)},")
        append("\"scenes\":${list(s.scenes)},")
        append("\"photoCount\":${s.photoCount},\"videoCount\":${s.videoCount},")
        append("\"confidence\":\"${esc(s.confidence)}\",")
        append("\"status\":\"${esc(s.status)}\",")
        append("\"aiNote\":\"${esc(s.aiNote)}\",")
        append("\"deck\":\"${esc(s.deck)}\",")
        append("\"body\":\"${esc(s.body)}\",")
        append("\"pull\":\"${esc(s.pull)}\"")
        if (withMedia) {
            append(",\"media\":[")
            db().storyMediaDao().of(s.id).forEachIndexed { i, sm ->
                if (i > 0) append(',')
                val m = db().mediaDao().byId(sm.mediaId)
                append("{\"id\":\"${esc(sm.mediaId)}\",")
                append("\"role\":\"${esc(sm.role)}\",")
                append("\"order\":${sm.orderNo},")
                if (m != null) {
                    append("\"type\":\"${esc(m.type)}\",")
                    append("\"uri\":\"${esc(m.uri)}\",")
                    append("\"durationSec\":${m.durationSec}")
                } else {
                    append("\"type\":\"photo\",\"uri\":\"\",\"durationSec\":0")
                }
                append("}")
            }
            append("]")
        }
        append("}")
    }

    private fun list(csv: String): String =
        csv.split(',').filter { it.isNotBlank() }
            .joinToString(",", "[", "]") { "\"${esc(it.trim())}\"" }

    private fun range(start: Long, end: Long): String {
        val f = DateTimeFormatter.ofPattern("yyyy.MM.dd")
        val z = ZoneId.systemDefault()
        val a = Instant.ofEpochMilli(start).atZone(z).toLocalDate().format(f)
        val b = Instant.ofEpochMilli(end).atZone(z).toLocalDate().format(f)
        return if (a == b) a else "$a — $b"
    }

    private fun esc(s: String): String = buildString(s.length + 8) {
        for (c in s) {
            when (c) {
                '"' -> append("\\\"")
                '\\' -> append("\\\\")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                else -> if (c < ' ') append("\\u%04x".format(c.code)) else append(c)
            }
        }
    }

    /* ---------------- 响应 ---------------- */

    private fun ok(body: String) = WebResourceResponse(
        "application/json", "UTF-8", 200, "OK",
        mapOf("Cache-Control" to "no-store"),
        ByteArrayInputStream(body.toByteArray(Charsets.UTF_8))
    )

    private fun error(code: Int, msg: String) = WebResourceResponse(
        "application/json", "UTF-8", code, "ERR",
        mapOf("Cache-Control" to "no-store"),
        ByteArrayInputStream("""{"error":"${esc(msg)}"}""".toByteArray(Charsets.UTF_8))
    )
}
