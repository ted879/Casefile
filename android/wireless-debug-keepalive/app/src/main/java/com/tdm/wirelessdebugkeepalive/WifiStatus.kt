package com.tdm.wirelessdebugkeepalive

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.NetworkRequest

/**
 * Wi-Fi reachability, read through ConnectivityManager / NetworkCapabilities.
 *
 * Wireless debugging only listens on a Wi-Fi interface, so there is no point in
 * restoring the setting while the phone is on mobile data only.
 */
object WifiStatus {

    fun isWifiConnected(context: Context): Boolean {
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return false
        return try {
            val active = cm.activeNetwork ?: return false
            val caps = cm.getNetworkCapabilities(active) ?: return false
            // A VPN network's capabilities carry the underlying transports, so a VPN
            // riding on Wi-Fi still reports TRANSPORT_WIFI here.
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
        } catch (t: Throwable) {
            LogStore.get(context).exception("reading Wi-Fi state", t)
            false
        }
    }

    fun wifiRequest(): NetworkRequest = NetworkRequest.Builder()
        .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
        .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
        .build()
}
