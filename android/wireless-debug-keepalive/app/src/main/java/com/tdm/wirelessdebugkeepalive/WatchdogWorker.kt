package com.tdm.wirelessdebugkeepalive

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/**
 * Recovery net for the cases a foreground service cannot cover on its own: the process
 * being killed without a sticky restart, or Android refusing a background service start.
 *
 * Runs at the WorkManager minimum period (15 minutes), only while Wi-Fi is connected.
 * It restarts the monitoring service if it is not running, and performs the same
 * guarded restore check the service would have performed.
 */
class WatchdogWorker(
    appContext: Context,
    params: WorkerParameters,
) : Worker(appContext, params) {

    override fun doWork(): Result {
        val context = applicationContext
        if (!Prefs.isKeepAliveEnabled(context)) {
            cancel(context)
            return Result.success()
        }

        if (!KeepAliveState.serviceRunning) {
            LogStore.get(context).add(
                LogStore.Category.SERVICE,
                "Watchdog: monitoring service was not running; restarting it"
            )
            KeepAliveService.start(context)
        }

        if (SecureSettings.readAdbWifiEnabled(context) == 0) {
            RestoreEngine.attemptRestore(context, "watchdog check")
        }
        return Result.success()
    }

    companion object {
        private const val UNIQUE_NAME = "keepalive-watchdog"

        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<WatchdogWorker>(15, TimeUnit.MINUTES)
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.UNMETERED)
                        .build()
                )
                .build()
            runCatching {
                WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                    UNIQUE_NAME,
                    ExistingPeriodicWorkPolicy.UPDATE,
                    request,
                )
            }.onFailure { LogStore.get(context).exception("scheduling the watchdog", it) }
        }

        fun cancel(context: Context) {
            runCatching { WorkManager.getInstance(context).cancelUniqueWork(UNIQUE_NAME) }
        }
    }
}
