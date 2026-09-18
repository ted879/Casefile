package com.tdm.wirelessdebugkeepalive

import android.content.Context
import android.content.SharedPreferences

/**
 * The single persisted user preference: whether KeepAlive should be maintaining
 * the user's Wireless Debugging setting. Nothing else is stored.
 */
object Prefs {

    private const val FILE = "keepalive_prefs"
    private const val KEY_ENABLED = "keep_alive_enabled"

    private fun prefs(context: Context): SharedPreferences =
        context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    fun isKeepAliveEnabled(context: Context): Boolean =
        prefs(context).getBoolean(KEY_ENABLED, false)

    fun setKeepAliveEnabled(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(KEY_ENABLED, enabled).apply()
    }
}
