package com.tdm.wirelessdebugkeepalive

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings

/**
 * Thin, read-mostly wrapper around the single Settings.Global key this app cares about.
 *
 * `adb_wifi_enabled`: 0 = Wireless debugging off, 1 = on. Nothing else in Settings is
 * read or written — USB debugging (`adb_enabled`), the ADB pairing/key store, and every
 * other secure setting are left strictly alone.
 */
object SecureSettings {

    const val KEY_ADB_WIFI_ENABLED = "adb_wifi_enabled"

    sealed class WriteResult {
        object Success : WriteResult()
        object NoPermission : WriteResult()
        data class Failed(val reason: String) : WriteResult()
    }

    fun uri(): Uri = Settings.Global.getUriFor(KEY_ADB_WIFI_ENABLED)

    /** Raw value, defaulting to 0 when the key is absent or unreadable. */
    fun readAdbWifiEnabled(context: Context): Int =
        try {
            Settings.Global.getInt(context.contentResolver, KEY_ADB_WIFI_ENABLED, 0)
        } catch (t: Throwable) {
            LogStore.get(context).exception("reading $KEY_ADB_WIFI_ENABLED", t)
            0
        }

    fun isWirelessDebuggingOn(context: Context): Boolean = readAdbWifiEnabled(context) == 1

    fun hasWriteSecureSettings(context: Context): Boolean =
        context.checkSelfPermission(Manifest.permission.WRITE_SECURE_SETTINGS) ==
            PackageManager.PERMISSION_GRANTED

    /**
     * Writes `adb_wifi_enabled = 1` and reads it straight back to confirm.
     * Never writes 0 — this app only ever turns Wireless Debugging on.
     */
    fun enableWirelessDebugging(context: Context): WriteResult {
        if (!hasWriteSecureSettings(context)) return WriteResult.NoPermission
        return try {
            val written = Settings.Global.putInt(context.contentResolver, KEY_ADB_WIFI_ENABLED, 1)
            if (!written) return WriteResult.Failed("putInt returned false")
            val readBack = readAdbWifiEnabled(context)
            if (readBack == 1) WriteResult.Success
            else WriteResult.Failed("wrote 1 but read back $readBack")
        } catch (e: SecurityException) {
            WriteResult.NoPermission
        } catch (t: Throwable) {
            LogStore.get(context).exception("writing $KEY_ADB_WIFI_ENABLED", t)
            WriteResult.Failed("${t.javaClass.simpleName}: ${t.message}")
        }
    }
}
