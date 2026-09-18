package com.tdm.wirelessdebugkeepalive

import android.content.Context
import android.util.Log
import java.io.File
import java.text.SimpleDateFormat
import java.util.ArrayDeque
import java.util.Date
import java.util.Locale
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors

private const val TAG = "KeepAlive"
private const val MAX_ENTRIES = 1000
private const val MAX_FILE_BYTES = 256L * 1024L
private const val TIME_PATTERN = "yyyy-MM-dd HH:mm:ss.SSS"

/** SimpleDateFormat is not thread safe, so every use goes through this lock. */
private val formatter = SimpleDateFormat(TIME_PATTERN, Locale.US)

private fun formatTimestamp(millis: Long): String = synchronized(formatter) {
    formatter.format(Date(millis))
}

private fun parseTimestamp(text: String): Long? = synchronized(formatter) {
    runCatching { formatter.parse(text)?.time }.getOrNull()
}

/**
 * In-app diagnostic log.
 *
 * Records only what this app does to the `adb_wifi_enabled` setting, plus Wi-Fi
 * transport up/down transitions and its own errors. It never touches call data,
 * phone numbers, contacts, Bluetooth audio, or any other app's data, and the log
 * never leaves the device unless the user copies it themselves.
 */
class LogStore private constructor(context: Context) {

    enum class Category { SERVICE, SETTING, WIFI, RESTORE, PERMISSION, TILE, USER, ERROR }

    data class Entry(val timestampMs: Long, val category: Category, val message: String) {
        fun format(): String = "${formatTimestamp(timestampMs)}  [${category.name}] $message"
    }

    private val appContext = context.applicationContext
    private val entries = ArrayDeque<Entry>()
    private val listeners = CopyOnWriteArrayList<() -> Unit>()
    private val writer = Executors.newSingleThreadExecutor { r -> Thread(r, "keepalive-log") }
    private val logFile: File by lazy { File(appContext.filesDir, "keepalive-log.txt") }

    init {
        writer.execute { restoreFromDisk() }
    }

    fun add(category: Category, message: String) {
        val entry = Entry(System.currentTimeMillis(), category, message)
        synchronized(entries) {
            entries.addLast(entry)
            while (entries.size > MAX_ENTRIES) entries.removeFirst()
        }
        Log.i(TAG, entry.format())
        writer.execute { appendToDisk(entry) }
        listeners.forEach { runCatching { it.invoke() } }
    }

    fun exception(what: String, t: Throwable) {
        add(Category.ERROR, "$what failed: ${t.javaClass.simpleName}: ${t.message}")
    }

    /** Newest first, capped, for on-screen display. */
    fun recentText(limit: Int = 200): String {
        val snapshot = snapshot()
        if (snapshot.isEmpty()) return ""
        return snapshot.asReversed().take(limit).joinToString("\n") { it.format() }
    }

    /** Oldest first, everything retained, for the "Copy Log" button. */
    fun fullText(): String = snapshot().joinToString("\n") { it.format() }

    fun snapshot(): List<Entry> = synchronized(entries) { entries.toList() }

    fun clear() {
        synchronized(entries) { entries.clear() }
        writer.execute { runCatching { logFile.delete() } }
        listeners.forEach { runCatching { it.invoke() } }
    }

    fun addListener(listener: () -> Unit) {
        listeners.add(listener)
    }

    fun removeListener(listener: () -> Unit) {
        listeners.remove(listener)
    }

    private fun appendToDisk(entry: Entry) {
        try {
            if (logFile.exists() && logFile.length() > MAX_FILE_BYTES) trimFile()
            logFile.appendText(entry.format() + "\n")
        } catch (t: Throwable) {
            Log.w(TAG, "could not persist log entry", t)
        }
    }

    private fun trimFile() {
        try {
            val kept = logFile.readLines().takeLast(MAX_ENTRIES / 2)
            logFile.writeText(kept.joinToString("\n", postfix = "\n"))
        } catch (t: Throwable) {
            runCatching { logFile.delete() }
        }
    }

    private fun restoreFromDisk() {
        try {
            if (!logFile.exists()) return
            val lines = logFile.readLines().takeLast(MAX_ENTRIES)
            if (lines.isEmpty()) return
            val parsed = lines.mapNotNull { parseLine(it) }
            synchronized(entries) {
                parsed.asReversed().forEach { entries.addFirst(it) }
                while (entries.size > MAX_ENTRIES) entries.removeFirst()
            }
            listeners.forEach { runCatching { it.invoke() } }
        } catch (t: Throwable) {
            Log.w(TAG, "could not restore log", t)
        }
    }

    private fun parseLine(line: String): Entry? {
        // "<timestamp>  [CATEGORY] message"
        val open = line.indexOf('[')
        val close = line.indexOf(']', startIndex = open + 1)
        if (open <= 0 || close <= open) return null
        val stamp = line.substring(0, open).trim()
        val category = runCatching { Category.valueOf(line.substring(open + 1, close)) }.getOrNull()
            ?: return null
        val millis = parseTimestamp(stamp) ?: return null
        return Entry(millis, category, line.substring(close + 1).trim())
    }

    companion object {
        @Volatile
        private var instance: LogStore? = null

        fun get(context: Context): LogStore =
            instance ?: synchronized(this) {
                instance ?: LogStore(context).also { instance = it }
            }
    }
}
