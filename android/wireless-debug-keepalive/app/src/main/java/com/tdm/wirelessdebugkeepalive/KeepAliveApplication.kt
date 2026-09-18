package com.tdm.wirelessdebugkeepalive

import android.app.Application

class KeepAliveApplication : Application() {

    override fun onCreate() {
        super.onCreate()
        // Touch the log store early so the on-disk history is loaded before the UI asks.
        LogStore.get(this)
    }
}
