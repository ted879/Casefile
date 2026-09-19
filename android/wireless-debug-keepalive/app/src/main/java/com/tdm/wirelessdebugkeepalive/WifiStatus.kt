package com.tdm.wirelessdebugkeepalive

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.NetworkRequest

/**
 * Wi-Fi reachability, read through ConnectivityManager / NetworkCapabilities.
 *
 * Wireless Debugging listens on a Wi-Fi interface. That includes Wi-Fi links with no
 * internet at all, such as an Android Auto projection link, so neither the check nor
 * the network request may insist on internet connectivity.
 */
object WifiStatus {

    fun isWifiConnected(context: Context): Boolean {
        // The service's own callback knows a Wi-Fi network has arrived before
        // activeNetwork switches over to it.
        if (KeepAliveState.serviceRunning && KeepAliveState.wifiNetworkCount > 0) return true
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return false
        return try {
            // A VPN network's capabilities carry the underlying transports, so a VPN
            // riding on Wi-Fi still reports TRANSPORT_WIFI here.
            val active = cm.activeNetwork
            if (active != null && cm.getNetworkCapabilities(active)
                    ?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
            ) {
                return true
            }
            // activeNetwork names whichever network carries traffic, which stays on
            // cellular for a Wi-Fi link that has no internet - an Android Auto
            // projection link, a printer, a camera. Wireless Debugging runs over those
            // perfectly well, so look at every network rather than just the default one.
            @Suppress("DEPRECATION")
            cm.allNetworks.any { network ->
                cm.getNetworkCapabilities(network)
                    ?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
            }
        } catch (t: Throwable) {
            LogStore.get(context).exception("reading Wi-Fi state", t)
            false
        }
    }

    /**
     * Matches ANY Wi-Fi network, with no capability filtering whatsoever.
     *
     * NetworkRequest.Builder() applies default filters - NOT_RESTRICTED, TRUSTED,
     * NOT_VPN - and an Android Auto projection link does not necessarily satisfy
     * them, so onAvailable never fired for it even after the INTERNET requirement
     * was dropped. clearCapabilities() removes those defaults, which is what makes
     * the truck link actually trigger a restore rather than merely show up in the
     * status row.
     */
    fun wifiRequest(): NetworkRequest = NetworkRequest.Builder()
        .clearCapabilities()
        .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
        .build()

    /** Fallback if the permissive request above is refused. */
    fun conservativeWifiRequest(): NetworkRequest = NetworkRequest.Builder()
        .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
        .build()
}
