package com.tdm.wirelessdebugkeepalive

import android.content.Context
import android.content.SharedPreferences

/**
 * The persisted user preferences: whether KeepAlive should be maintaining the
 * user's Wireless Debugging setting, and whether it should try even with no Wi-Fi.
 * Nothing else is stored.
 */
object Prefs {

    private const val FILE = "keepalive_prefs"
    private const val KEY_ENABLED = "keep_alive_enabled"
    private const val KEY_RESTORE_WITHOUT_WIFI = "restore_without_wifi"

    private fun prefs(context: Context): SharedPreferences =
        context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    fun isKeepAliveEnabled(context: Context): Boolean =
        prefs(context).getBoolean(KEY_ENABLED, false)

    fun setKeepAliveEnabled(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(KEY_ENABLED, enabled).apply()
    }

    /**
     * Attempt a restore even when no Wi-Fi network is connected.
     *
     * Android's own AdbDebuggingManager normally clears adb_wifi_enabled when Wi-Fi
     * goes away, so a write with no Wi-Fi may simply be reverted. The restore guard
     * caps how often that can be retried.
     */
    fun isRestoreWithoutWifiEnabled(context: Context): Boolean =
        prefs(context).getBoolean(KEY_RESTORE_WITHOUT_WIFI, true)

    fun setRestoreWithoutWifiEnabled(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(KEY_RESTORE_WITHOUT_WIFI, enabled).apply()
    }
}
