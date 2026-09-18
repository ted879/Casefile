package com.tdm.wirelessdebugkeepalive

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.database.ContentObserver
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * The monitor.
 *
 * A specialUse foreground service that:
 *  - watches Settings.Global/adb_wifi_enabled with a ContentObserver (no polling),
 *  - watches Wi-Fi with a ConnectivityManager.NetworkCallback,
 *  - and asks [RestoreEngine] to put the setting back to 1 when it is turned off,
 *    after a ~1 second settle delay and subject to the loop guard.
 *
 * A low-frequency heartbeat (default 15 minutes) re-checks the value in case a
 * setting-change callback was ever missed. That is a read, not a write: nothing is
 * written unless the value is actually 0.
 */
class KeepAliveService : Service() {

    private val handler = Handler(Looper.getMainLooper())
    private var settingsObserver: ContentObserver? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var lastSeenValue = -1

    private val log: LogStore by lazy { LogStore.get(this) }

    private val restoreRunnable = Runnable { runRestoreCheck(pendingReason ?: "setting change") }
    private var pendingReason: String? = null

    private val heartbeatRunnable = object : Runnable {
        override fun run() {
            // A read, not a write: only act when the value has actually gone to 0.
            val value = SecureSettings.readAdbWifiEnabled(this@KeepAliveService)
            if (value != lastSeenValue) onAdbWifiSettingChanged()
            if (value == 0) runRestoreCheck("periodic re-check")
            handler.postDelayed(this, HEARTBEAT_INTERVAL_MS)
        }
    }

    private val stateListener: () -> Unit = { handler.post { updateNotification() } }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        KeepAliveState.serviceRunning = true
        KeepAliveState.addListener(stateListener)
        log.add(LogStore.Category.SERVICE, "Monitoring service created")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // intent is null when Android restarts a START_STICKY service after the
        // process was killed; that is the normal resume path.
        val action = intent?.action ?: ACTION_START

        if (!startForegroundSafely()) {
            stopSelf()
            return START_NOT_STICKY
        }

        when (action) {
            ACTION_STOP -> {
                log.add(LogStore.Category.SERVICE, "Stop requested")
                stopMonitoring()
                ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_RESTORE_NOW -> {
                startMonitoring(intent == null)
                RestoreEngine.attemptRestore(this, "user requested", force = true)
            }
            ACTION_RESET_LIMIT -> {
                RestoreEngine.resetGuard(this)
                startMonitoring(intent == null)
            }
            else -> startMonitoring(intent == null)
        }

        updateNotification()
        return START_STICKY
    }

    override fun onDestroy() {
        log.add(LogStore.Category.SERVICE, "Monitoring service destroyed")
        stopMonitoring()
        KeepAliveState.removeListener(stateListener)
        KeepAliveState.serviceRunning = false
        super.onDestroy()
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // Keep monitoring when the user swipes the app away.
        log.add(LogStore.Category.SERVICE, "Task removed; monitoring continues")
        super.onTaskRemoved(rootIntent)
    }

    // ---------------------------------------------------------------- monitoring

    private fun startMonitoring(restarted: Boolean) {
        if (restarted) {
            log.add(LogStore.Category.SERVICE, "Service restarted by Android after process termination")
        }
        registerSettingsObserver()
        registerNetworkCallback()

        handler.removeCallbacks(heartbeatRunnable)
        handler.postDelayed(heartbeatRunnable, HEARTBEAT_INTERVAL_MS)

        lastSeenValue = SecureSettings.readAdbWifiEnabled(this)
        log.add(
            LogStore.Category.SERVICE,
            "Monitoring started (adb_wifi_enabled=$lastSeenValue, Wi-Fi " +
                (if (WifiStatus.isWifiConnected(this)) "connected" else "not connected") + ")"
        )
        if (lastSeenValue == 0) scheduleRestoreCheck("monitoring started while off")
    }

    private fun stopMonitoring() {
        handler.removeCallbacks(restoreRunnable)
        handler.removeCallbacks(heartbeatRunnable)
        handler.removeCallbacks(stickCheckRunnable)
        settingsObserver?.let {
            runCatching { contentResolver.unregisterContentObserver(it) }
        }
        settingsObserver = null
        networkCallback?.let { cb ->
            runCatching {
                getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(cb)
            }
        }
        networkCallback = null
        KeepAliveState.wifiNetworkCount = 0
    }

    private fun registerSettingsObserver() {
        if (settingsObserver != null) return
        val observer = object : ContentObserver(handler) {
            override fun onChange(selfChange: Boolean, uri: Uri?) {
                onAdbWifiSettingChanged()
            }
        }
        try {
            contentResolver.registerContentObserver(SecureSettings.uri(), false, observer)
            settingsObserver = observer
        } catch (t: Throwable) {
            log.exception("registering the adb_wifi_enabled observer", t)
        }
    }

    private fun registerNetworkCallback() {
        if (networkCallback != null) return
        val cm = getSystemService(ConnectivityManager::class.java) ?: return
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                KeepAliveState.wifiNetworkCount += 1
                val hasInternet = getSystemService(ConnectivityManager::class.java)
                    ?.getNetworkCapabilities(network)
                    ?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
                log.add(
                    LogStore.Category.WIFI,
                    "Wi-Fi connected" +
                        if (hasInternet) "" else " (no internet - projection or local-only link)"
                )
                scheduleRestoreCheck("Wi-Fi became available")
            }

            override fun onLost(network: Network) {
                KeepAliveState.wifiNetworkCount =
                    (KeepAliveState.wifiNetworkCount - 1).coerceAtLeast(0)
                log.add(LogStore.Category.WIFI, "Wi-Fi disconnected")
                handler.post { updateNotification() }
            }
        }
        try {
            cm.registerNetworkCallback(WifiStatus.wifiRequest(), callback, handler)
            networkCallback = callback
        } catch (t: Throwable) {
            log.exception("registering the Wi-Fi network callback", t)
        }
    }

    private fun onAdbWifiSettingChanged() {
        val value = SecureSettings.readAdbWifiEnabled(this)
        if (value == lastSeenValue) return
        val previous = lastSeenValue
        lastSeenValue = value
        log.add(
            LogStore.Category.SETTING,
            "adb_wifi_enabled changed: " +
                (if (previous < 0) "(unknown)" else previous.toString()) + " -> $value"
        )
        handler.post { updateNotification() }
        if (value == 0) {
            scheduleRestoreCheck("Wireless Debugging was turned off")
        }
    }

    /**
     * Coalesces bursts of callbacks and gives the system ~1 second to settle before
     * re-reading the value, so a momentary flip is never answered with a write.
     */
    private fun scheduleRestoreCheck(reason: String) {
        if (!Prefs.isKeepAliveEnabled(this)) return
        pendingReason = reason
        handler.removeCallbacks(restoreRunnable)
        handler.postDelayed(restoreRunnable, SETTLE_DELAY_MS)
    }

    private fun runRestoreCheck(reason: String) {
        pendingReason = null
        val outcome = RestoreEngine.attemptRestore(this, reason)
        lastSeenValue = SecureSettings.readAdbWifiEnabled(this)
        if (outcome == RestoreEngine.Outcome.RESTORED) scheduleStickCheck()
        updateNotification()
    }

    /**
     * A restore write can be accepted and then undone by the framework moments later —
     * that is what happens when Wireless Debugging is turned on with no Wi-Fi. Record
     * whether the value actually stuck, so the log says why rather than just retrying.
     */
    private fun scheduleStickCheck() {
        handler.removeCallbacks(stickCheckRunnable)
        handler.postDelayed(stickCheckRunnable, STICK_CHECK_DELAY_MS)
    }

    private val stickCheckRunnable = Runnable {
        val value = SecureSettings.readAdbWifiEnabled(this)
        if (value == 1) {
            RestoreEngine.confirmRestoreStuck()
            log.add(LogStore.Category.RESTORE, "Confirmed: still ON 3s after the restore")
        } else {
            val wifi = WifiStatus.isWifiConnected(this)
            log.add(
                LogStore.Category.RESTORE,
                "Android reverted adb_wifi_enabled to 0 within 3s of the restore" +
                    if (!wifi) " - no Wi-Fi is connected, which is the usual cause." else "."
            )
        }
    }

    // ------------------------------------------------------------- notification

    private fun startForegroundSafely(): Boolean {
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        } else {
            0
        }
        return try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(), type)
            true
        } catch (t: Throwable) {
            // e.g. ForegroundServiceStartNotAllowedException when Android refuses a
            // background start. The watchdog worker retries later.
            log.exception("starting the foreground service", t)
            WatchdogWorker.schedule(this)
            false
        }
    }

    private fun createNotificationChannel() {
        val manager = getSystemService(NotificationManager::class.java) ?: return
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.notification_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = getString(R.string.notification_channel_description)
            setShowBadge(false)
            enableVibration(false)
            enableLights(false)
        }
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        val contentIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_IMMUTABLE,
        )

        val text = when {
            KeepAliveState.autoRetrySuspended -> getString(R.string.notification_text_suspended)
            !SecureSettings.hasWriteSecureSettings(this) -> getString(R.string.notification_text_no_permission)
            else -> getString(R.string.notification_text_monitoring)
        }

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setOngoing(true)
            .setShowWhen(false)
            .setSilent(true)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(contentIntent)
            .build()
    }

    private fun updateNotification() {
        if (!KeepAliveState.serviceRunning) return
        val manager = getSystemService(NotificationManager::class.java) ?: return
        runCatching { manager.notify(NOTIFICATION_ID, buildNotification()) }
    }

    companion object {
        const val ACTION_START = "com.tdm.wirelessdebugkeepalive.action.START"
        const val ACTION_STOP = "com.tdm.wirelessdebugkeepalive.action.STOP"
        const val ACTION_RESTORE_NOW = "com.tdm.wirelessdebugkeepalive.action.RESTORE_NOW"
        const val ACTION_RESET_LIMIT = "com.tdm.wirelessdebugkeepalive.action.RESET_LIMIT"

        private const val CHANNEL_ID = "keepalive_monitor"
        private const val NOTIFICATION_ID = 1001

        /** How long to let the system settle before re-reading the value. */
        const val SETTLE_DELAY_MS = 1_000L

        /** How long to wait before checking that a restore actually stuck. */
        const val STICK_CHECK_DELAY_MS = 3_000L

        /** Low-frequency safety net; deliberately far from a polling loop. */
        const val HEARTBEAT_INTERVAL_MS = 15L * 60L * 1000L

        fun start(context: Context, action: String = ACTION_START): Boolean {
            val intent = Intent(context, KeepAliveService::class.java).setAction(action)
            return try {
                context.startForegroundService(intent)
                true
            } catch (t: Throwable) {
                LogStore.get(context).exception("starting the monitoring service", t)
                false
            }
        }

        fun stop(context: Context) {
            val intent = Intent(context, KeepAliveService::class.java).setAction(ACTION_STOP)
            runCatching { context.startService(intent) }
                .onFailure {
                    // Background start refused: the service is not running anyway.
                    context.stopService(Intent(context, KeepAliveService::class.java))
                }
        }
    }
}
