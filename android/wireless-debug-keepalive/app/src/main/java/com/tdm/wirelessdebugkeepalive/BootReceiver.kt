package com.tdm.wirelessdebugkeepalive

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Resumes monitoring after a reboot or an app update, but only if the user had
 * KeepAlive switched on.
 *
 * Starting a foreground service from BOOT_COMPLETED is still permitted on Android 15/16
 * for the specialUse type (dataSync, camera, mediaPlayback, mediaProjection, microphone
 * and phoneCall are the types that are blocked there). The start is still wrapped, and
 * the watchdog worker is scheduled either way.
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_MY_PACKAGE_REPLACED) {
            return
        }

        val log = LogStore.get(context)
        if (!Prefs.isKeepAliveEnabled(context)) {
            log.add(LogStore.Category.SERVICE, "$action received; KeepAlive is off, not starting")
            return
        }

        log.add(LogStore.Category.SERVICE, "$action received; resuming monitoring")
        WatchdogWorker.schedule(context)
        if (!KeepAliveService.start(context)) {
            log.add(
                LogStore.Category.SERVICE,
                "Could not start the service at boot; the watchdog will retry"
            )
        }
    }
}
