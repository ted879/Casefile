package com.tdm.wirelessdebugkeepalive

import java.util.concurrent.CopyOnWriteArrayList

/**
 * Process-wide, non-persistent view of what the monitor is doing, so the activity,
 * the notification and the Quick Settings tile all report the same thing.
 */
object KeepAliveState {

    @Volatile
    var serviceRunning: Boolean = false
        set(value) {
            field = value
            notifyChanged()
        }

    /** True once Android has forced Wireless Debugging back off too many times in a row. */
    @Volatile
    var autoRetrySuspended: Boolean = false
        set(value) {
            val changed = field != value
            field = value
            if (changed) notifyChanged()
        }

    @Volatile
    var lastRestoreAtMs: Long = 0L

    @Volatile
    var restoreCount: Int = 0

    private val listeners = CopyOnWriteArrayList<() -> Unit>()

    fun addListener(listener: () -> Unit) {
        listeners.add(listener)
    }

    fun removeListener(listener: () -> Unit) {
        listeners.remove(listener)
    }

    fun notifyChanged() {
        listeners.forEach { runCatching { it.invoke() } }
    }
}
