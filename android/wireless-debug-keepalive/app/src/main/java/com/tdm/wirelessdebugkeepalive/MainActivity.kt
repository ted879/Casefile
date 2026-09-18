package com.tdm.wirelessdebugkeepalive

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.view.View
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import com.tdm.wirelessdebugkeepalive.databinding.ActivityMainBinding
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private val handler = Handler(Looper.getMainLooper())
    private val log: LogStore by lazy { LogStore.get(this) }

    /** Guards against the programmatic switch update re-entering the listener. */
    private var updatingUi = false

    private var settingsObserver: ContentObserver? = null
    private val stateListener: () -> Unit = { handler.post { refresh() } }
    private val logListener: () -> Unit = { handler.post { refreshLog() } }

    private val uiRefresh = object : Runnable {
        override fun run() {
            refresh()
            handler.postDelayed(this, UI_REFRESH_MS)
        }
    }

    private val notificationPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (!granted) toast(getString(R.string.toast_notifications_needed))
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.switchKeepAlive.setOnCheckedChangeListener { _, checked ->
            if (updatingUi) return@setOnCheckedChangeListener
            onKeepAliveToggled(checked)
        }

        binding.switchRestoreWithoutWifi.setOnCheckedChangeListener { _, checked ->
            if (updatingUi) return@setOnCheckedChangeListener
            Prefs.setRestoreWithoutWifiEnabled(this, checked)
            log.add(
                LogStore.Category.USER,
                "Restore even without Wi-Fi switched " + (if (checked) "ON" else "OFF")
            )
        }

        binding.btnEnableNow.setOnClickListener {
            log.add(LogStore.Category.USER, "\"Enable Wireless Debugging Now\" pressed")
            val outcome = RestoreEngine.attemptRestore(
                this,
                "user pressed Enable Wireless Debugging Now",
                force = true,
            )
            toast(describe(outcome))
            refresh()
        }

        binding.btnDeveloperOptions.setOnClickListener { openDeveloperOptions() }

        binding.btnStartMonitoring.setOnClickListener {
            log.add(LogStore.Category.USER, "\"Start Monitoring\" pressed")
            ensureNotificationPermission()
            if (KeepAliveService.start(this)) {
                WatchdogWorker.schedule(this)
                toast(getString(R.string.toast_monitoring_started))
                if (!Prefs.isKeepAliveEnabled(this)) {
                    toast(getString(R.string.switch_keep_alive) + ": OFF")
                }
            }
            handler.postDelayed({ refresh() }, 400)
        }

        binding.btnStopMonitoring.setOnClickListener {
            log.add(LogStore.Category.USER, "\"Stop Monitoring\" pressed")
            KeepAliveService.stop(this)
            WatchdogWorker.cancel(this)
            toast(getString(R.string.toast_monitoring_stopped))
            handler.postDelayed({ refresh() }, 400)
        }

        binding.btnBatterySettings.setOnClickListener { openBatterySettings() }

        binding.btnResetLimit.setOnClickListener {
            RestoreEngine.resetGuard(this)
            refresh()
        }

        binding.btnCopyGrant.setOnClickListener {
            copyToClipboard("adb grant command", getString(R.string.grant_command))
        }
        binding.btnCopyRevoke.setOnClickListener {
            copyToClipboard("adb revoke command", getString(R.string.revoke_command))
        }
        binding.btnCopyLog.setOnClickListener {
            val text = log.fullText()
            copyToClipboard("Wireless Debug KeepAlive log", text.ifEmpty { getString(R.string.log_empty) })
            toast(getString(R.string.toast_log_copied))
        }
        binding.btnClearLog.setOnClickListener {
            log.clear()
            log.add(LogStore.Category.USER, "Log cleared by user")
            refreshLog()
        }
    }

    override fun onResume() {
        super.onResume()
        registerSettingsObserver()
        KeepAliveState.addListener(stateListener)
        log.addListener(logListener)
        handler.removeCallbacks(uiRefresh)
        handler.post(uiRefresh)
    }

    override fun onPause() {
        handler.removeCallbacks(uiRefresh)
        log.removeListener(logListener)
        KeepAliveState.removeListener(stateListener)
        settingsObserver?.let { runCatching { contentResolver.unregisterContentObserver(it) } }
        settingsObserver = null
        super.onPause()
    }

    // ------------------------------------------------------------------- actions

    private fun onKeepAliveToggled(enabled: Boolean) {
        Prefs.setKeepAliveEnabled(this, enabled)
        log.add(
            LogStore.Category.USER,
            "Keep Wireless Debugging On switched " + (if (enabled) "ON" else "OFF")
        )
        if (enabled) {
            ensureNotificationPermission()
            RestoreEngine.resetGuard(this)
            KeepAliveService.start(this)
            WatchdogWorker.schedule(this)
            if (!SecureSettings.hasWriteSecureSettings(this)) {
                toast(getString(R.string.toast_no_permission))
            }
        } else {
            KeepAliveService.stop(this)
            WatchdogWorker.cancel(this)
        }
        handler.postDelayed({ refresh() }, 400)
    }

    private fun ensureNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    private fun openDeveloperOptions() {
        log.add(LogStore.Category.USER, "\"Open Developer Options\" pressed")
        val candidates = listOf(
            Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS),
            Intent(Settings.ACTION_SETTINGS),
        )
        for (intent in candidates) {
            try {
                startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                return
            } catch (t: Throwable) {
                log.exception("opening ${intent.action}", t)
            }
        }
        toast(getString(R.string.toast_no_developer_options))
    }

    private fun openBatterySettings() {
        log.add(LogStore.Category.USER, "Battery settings opened")
        val power = getSystemService(PowerManager::class.java)
        val exempt = power?.isIgnoringBatteryOptimizations(packageName) == true
        if (!exempt) {
            val request = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                .setData(Uri.fromParts("package", packageName, null))
            try {
                startActivity(request)
                return
            } catch (t: Throwable) {
                log.exception("requesting battery-optimisation exemption", t)
            }
        }
        val details = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
            .setData(Uri.fromParts("package", packageName, null))
        try {
            startActivity(details)
        } catch (t: Throwable) {
            log.exception("opening app details settings", t)
            toast(getString(R.string.toast_no_developer_options))
        }
    }

    private fun copyToClipboard(label: String, text: String) {
        val clipboard = getSystemService(ClipboardManager::class.java) ?: return
        clipboard.setPrimaryClip(ClipData.newPlainText(label, text))
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            toast(getString(R.string.toast_copied))
        }
    }

    // -------------------------------------------------------------------- render

    private fun registerSettingsObserver() {
        if (settingsObserver != null) return
        val observer = object : ContentObserver(handler) {
            override fun onChange(selfChange: Boolean, uri: Uri?) {
                refresh()
            }
        }
        runCatching {
            contentResolver.registerContentObserver(SecureSettings.uri(), false, observer)
            settingsObserver = observer
        }
    }

    private fun refresh() {
        val wirelessOn = SecureSettings.isWirelessDebuggingOn(this)
        val keepAlive = Prefs.isKeepAliveEnabled(this)
        val granted = SecureSettings.hasWriteSecureSettings(this)
        val wifi = WifiStatus.isWifiConnected(this)
        val running = KeepAliveState.serviceRunning

        binding.valueWirelessDebugging.text = getString(if (wirelessOn) R.string.value_on else R.string.value_off)
        binding.valueKeepAlive.text = getString(if (keepAlive) R.string.value_on else R.string.value_off)
        binding.valuePermission.text =
            getString(if (granted) R.string.value_granted else R.string.value_not_granted)
        binding.valueWifi.text =
            getString(if (wifi) R.string.value_connected else R.string.value_not_connected)
        binding.valueService.text = getString(if (running) R.string.value_running else R.string.value_stopped)

        updatingUi = true
        binding.switchKeepAlive.isChecked = keepAlive
        binding.switchRestoreWithoutWifi.isChecked = Prefs.isRestoreWithoutWifiEnabled(this)
        updatingUi = false

        binding.textPermissionHelp.setText(
            if (granted) R.string.permission_help_granted else R.string.permission_help_missing
        )

        val suspended = KeepAliveState.autoRetrySuspended || RestoreEngine.guardIsSuspended()
        when {
            suspended -> {
                binding.bannerWarning.visibility = View.VISIBLE
                binding.bannerWarning.setText(R.string.banner_suspended)
                binding.btnResetLimit.visibility = View.VISIBLE
            }
            !granted -> {
                binding.bannerWarning.visibility = View.VISIBLE
                binding.bannerWarning.setText(R.string.banner_no_permission)
                binding.btnResetLimit.visibility = View.GONE
            }
            else -> {
                binding.bannerWarning.visibility = View.GONE
                binding.btnResetLimit.visibility = View.GONE
            }
        }

        val last = KeepAliveState.lastRestoreAtMs
        binding.textLastRestore.text = if (last == 0L) {
            getString(R.string.last_restore_never)
        } else {
            getString(
                R.string.last_restore_format,
                SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(Date(last)),
                KeepAliveState.restoreCount,
            )
        }

        refreshLog()
    }

    private fun refreshLog() {
        val text = log.recentText()
        binding.textLog.text = text.ifEmpty { getString(R.string.log_empty) }
    }

    private fun describe(outcome: RestoreEngine.Outcome): String = when (outcome) {
        RestoreEngine.Outcome.RESTORED -> getString(R.string.toast_restored)
        RestoreEngine.Outcome.ALREADY_ON -> getString(R.string.toast_already_on)
        RestoreEngine.Outcome.NO_PERMISSION -> getString(R.string.toast_no_permission)
        RestoreEngine.Outcome.NO_WIFI -> getString(R.string.toast_no_wifi)
        else -> getString(R.string.toast_restore_failed)
    }

    private fun toast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
    }

    companion object {
        private const val UI_REFRESH_MS = 2_000L
    }
}

