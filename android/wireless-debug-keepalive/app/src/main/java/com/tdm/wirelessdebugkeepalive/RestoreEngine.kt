package com.tdm.wirelessdebugkeepalive

import android.content.Context

/**
 * The one place that ever writes `adb_wifi_enabled`.
 *
 * The monitoring service, the boot/watchdog path, the Quick Settings tile and the
 * "Enable Wireless Debugging Now" button all funnel through here, so they share a
 * single [RestoreGuard] and cannot gang up into a write loop.
 */
object RestoreEngine {

    enum class Outcome {
        RESTORED,
        ALREADY_ON,
        KEEP_ALIVE_OFF,
        NO_PERMISSION,
        NO_WIFI,
        DEBOUNCED,
        SUSPENDED,
        WRITE_FAILED,
    }

    private val guard = RestoreGuard()

    fun guardIsSuspended(): Boolean = guard.isSuspended(now())

    fun attemptsInWindow(): Int = guard.attemptsInWindow(now())

    /**
     * Records that a restore held. Keeps a run of normal Wi-Fi reconnects from
     * counting towards the "Android keeps disabling this" rate limit.
     */
    fun confirmRestoreStuck() {
        guard.forgiveLastAttempt()
        KeepAliveState.autoRetrySuspended = false
    }

    /** Clears the rate limit. Only called for an explicit user action. */
    fun resetGuard(context: Context) {
        guard.reset()
        KeepAliveState.autoRetrySuspended = false
        LogStore.get(context).add(LogStore.Category.USER, "Automatic-retry limit reset by user")
    }

    /**
     * @param reason free text recorded in the diagnostic log
     * @param force  an explicit user action: ignores the master switch and the rate limit
     */
    fun attemptRestore(
        context: Context,
        reason: String,
        force: Boolean = false,
    ): Outcome {
        val log = LogStore.get(context)
        val appContext = context.applicationContext

        if (!force && !Prefs.isKeepAliveEnabled(appContext)) {
            log.add(LogStore.Category.RESTORE, "Skipped ($reason): KeepAlive master switch is off")
            return Outcome.KEEP_ALIVE_OFF
        }

        if (!SecureSettings.hasWriteSecureSettings(appContext)) {
            log.add(
                LogStore.Category.PERMISSION,
                "Skipped ($reason): WRITE_SECURE_SETTINGS is not granted"
            )
            return Outcome.NO_PERMISSION
        }

        if (SecureSettings.readAdbWifiEnabled(appContext) == 1) {
            log.add(LogStore.Category.RESTORE, "Nothing to do ($reason): adb_wifi_enabled is already 1")
            return Outcome.ALREADY_ON
        }

        if (!WifiStatus.isWifiConnected(appContext)) {
            if (!force && !Prefs.isRestoreWithoutWifiEnabled(appContext)) {
                log.add(LogStore.Category.RESTORE, "Skipped ($reason): Wi-Fi is not connected")
                return Outcome.NO_WIFI
            }
            log.add(
                LogStore.Category.WIFI,
                "Wi-Fi is not connected - attempting the restore anyway. Android normally " +
                    "clears adb_wifi_enabled without Wi-Fi, so this write may be reverted."
            )
        }

        val now = now()
        if (!force) {
            when (guard.evaluate(now)) {
                RestoreGuard.Decision.SUSPENDED -> {
                    KeepAliveState.autoRetrySuspended = true
                    log.add(
                        LogStore.Category.RESTORE,
                        "Skipped ($reason): automatic retry suspended — Android repeatedly disabled Wireless Debugging"
                    )
                    return Outcome.SUSPENDED
                }
                RestoreGuard.Decision.IN_QUIET_PERIOD -> {
                    log.add(LogStore.Category.RESTORE, "Skipped ($reason): inside post-restore quiet period")
                    return Outcome.DEBOUNCED
                }
                RestoreGuard.Decision.ALLOW -> Unit
            }
        } else {
            guard.reset()
            KeepAliveState.autoRetrySuspended = false
        }

        val trippedLimit = guard.recordAttempt(now)
        log.add(LogStore.Category.RESTORE, "Restoring adb_wifi_enabled to 1 ($reason)")

        return when (val result = SecureSettings.enableWirelessDebugging(appContext)) {
            is SecureSettings.WriteResult.Success -> {
                KeepAliveState.lastRestoreAtMs = now
                KeepAliveState.restoreCount += 1
                log.add(LogStore.Category.RESTORE, "Restore succeeded: Wireless Debugging is back ON")
                if (trippedLimit) {
                    KeepAliveState.autoRetrySuspended = true
                    log.add(
                        LogStore.Category.RESTORE,
                        "Android repeatedly disabled Wireless Debugging " +
                            "(${RestoreGuard.DEFAULT_MAX_ATTEMPTS} restores within " +
                            "${RestoreGuard.DEFAULT_WINDOW_MS / 60000} minutes). " +
                            "Automatic retry paused for ${RestoreGuard.DEFAULT_SUSPENSION_MS / 60000} minutes."
                    )
                }
                KeepAliveState.notifyChanged()
                Outcome.RESTORED
            }
            is SecureSettings.WriteResult.NoPermission -> {
                log.add(
                    LogStore.Category.PERMISSION,
                    "Restore failed: WRITE_SECURE_SETTINGS was refused at write time"
                )
                Outcome.NO_PERMISSION
            }
            is SecureSettings.WriteResult.Failed -> {
                log.add(LogStore.Category.RESTORE, "Restore failed: ${result.reason}")
                Outcome.WRITE_FAILED
            }
        }
    }

    private fun now(): Long = System.currentTimeMillis()
}
