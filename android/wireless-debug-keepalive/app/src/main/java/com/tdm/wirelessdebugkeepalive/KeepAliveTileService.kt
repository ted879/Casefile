package com.tdm.wirelessdebugkeepalive

import android.app.PendingIntent
import android.content.Intent
import android.graphics.drawable.Icon
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import android.widget.Toast

/**
 * Quick Settings tile: "Wireless Debug".
 *
 * Shows the live state of `adb_wifi_enabled`. Tapping it only ever tries to turn
 * Wireless Debugging ON — it never turns it off. With the permission missing it opens
 * the app instead, and with no Wi-Fi it says so and does nothing.
 */
class KeepAliveTileService : TileService() {

    override fun onStartListening() {
        super.onStartListening()
        updateTile()
    }

    override fun onTileAdded() {
        super.onTileAdded()
        LogStore.get(this).add(LogStore.Category.TILE, "Quick Settings tile added")
        updateTile()
    }

    override fun onClick() {
        super.onClick()
        val log = LogStore.get(this)
        log.add(LogStore.Category.TILE, "Quick Settings tile tapped")

        if (!SecureSettings.hasWriteSecureSettings(this)) {
            log.add(LogStore.Category.PERMISSION, "Tile tap ignored: WRITE_SECURE_SETTINGS not granted")
            toast(getString(R.string.toast_no_permission))
            openApp()
            return
        }

        if (SecureSettings.isWirelessDebuggingOn(this)) {
            toast(getString(R.string.toast_already_on))
            updateTile()
            return
        }

        if (!WifiStatus.isWifiConnected(this)) {
            log.add(LogStore.Category.TILE, "Tile tap ignored: Wi-Fi is not connected")
            toast(getString(R.string.toast_no_wifi))
            updateTile()
            return
        }

        val outcome = RestoreEngine.attemptRestore(
            this,
            "Quick Settings tile tap",
            force = true,
            requireWifi = true,
        )
        toast(
            when (outcome) {
                RestoreEngine.Outcome.RESTORED -> getString(R.string.toast_restored)
                RestoreEngine.Outcome.ALREADY_ON -> getString(R.string.toast_already_on)
                RestoreEngine.Outcome.NO_WIFI -> getString(R.string.toast_no_wifi)
                RestoreEngine.Outcome.NO_PERMISSION -> getString(R.string.toast_no_permission)
                else -> getString(R.string.toast_restore_failed)
            }
        )
        updateTile()
    }

    private fun updateTile() {
        val tile: Tile = qsTile ?: return
        val granted = SecureSettings.hasWriteSecureSettings(this)
        val on = SecureSettings.isWirelessDebuggingOn(this)

        tile.label = getString(R.string.tile_label)
        tile.icon = Icon.createWithResource(this, R.drawable.ic_tile)
        tile.state = when {
            !granted -> Tile.STATE_UNAVAILABLE
            on -> Tile.STATE_ACTIVE
            else -> Tile.STATE_INACTIVE
        }
        tile.subtitle = when {
            !granted -> getString(R.string.tile_subtitle_no_permission)
            on -> getString(R.string.tile_subtitle_on)
            !WifiStatus.isWifiConnected(this) -> getString(R.string.tile_subtitle_no_wifi)
            else -> getString(R.string.tile_subtitle_off)
        }
        runCatching { tile.updateTile() }
    }

    private fun openApp() {
        val intent = Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                val pendingIntent = PendingIntent.getActivity(
                    this,
                    0,
                    intent,
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                )
                startActivityAndCollapse(pendingIntent)
            } else {
                @Suppress("DEPRECATION")
                startActivityAndCollapse(intent)
            }
        } catch (t: Throwable) {
            LogStore.get(this).exception("opening the app from the tile", t)
        }
    }

    private fun toast(message: String) {
        Toast.makeText(applicationContext, message, Toast.LENGTH_SHORT).show()
    }
}
