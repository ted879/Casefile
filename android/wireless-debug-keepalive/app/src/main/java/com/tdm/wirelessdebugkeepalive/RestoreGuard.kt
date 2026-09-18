package com.tdm.wirelessdebugkeepalive

/**
 * Loop protection around the restore path.
 *
 * Two separate jobs:
 *
 *  1. A short quiet period after a successful restore, so the setting-change
 *     callback our own write provokes cannot bounce straight back into another write.
 *  2. A rate limit: if Android keeps forcing `adb_wifi_enabled` back to 0, stop
 *     retrying after [maxAttemptsInWindow] restores inside [windowMs] and stay
 *     suspended for [suspensionMs], instead of fighting the system indefinitely.
 *
 * Pure logic with an injected clock so it can be unit tested off-device.
 */
class RestoreGuard(
    private val maxAttemptsInWindow: Int = DEFAULT_MAX_ATTEMPTS,
    private val windowMs: Long = DEFAULT_WINDOW_MS,
    private val quietPeriodMs: Long = DEFAULT_QUIET_PERIOD_MS,
    private val suspensionMs: Long = DEFAULT_SUSPENSION_MS,
) {

    enum class Decision { ALLOW, IN_QUIET_PERIOD, SUSPENDED }

    private val attempts = ArrayDeque<Long>()
    private var quietUntilMs = 0L
    private var suspendedUntilMs = 0L

    @Synchronized
    fun evaluate(nowMs: Long): Decision {
        prune(nowMs)
        return when {
            nowMs < suspendedUntilMs -> Decision.SUSPENDED
            nowMs < quietUntilMs -> Decision.IN_QUIET_PERIOD
            else -> Decision.ALLOW
        }
    }

    /**
     * Records that a restore write was just issued. Returns true when that write
     * tripped the rate limit and automatic retries are now suspended.
     */
    @Synchronized
    fun recordAttempt(nowMs: Long): Boolean {
        prune(nowMs)
        attempts.addLast(nowMs)
        quietUntilMs = nowMs + quietPeriodMs
        if (attempts.size >= maxAttemptsInWindow) {
            suspendedUntilMs = nowMs + suspensionMs
            return true
        }
        return false
    }

    /**
     * Called once a restore has been observed to hold. A write the framework left alone
     * is not evidence of a fight, so it is dropped from the rate-limit window: ordinary
     * Wi-Fi reconnects must never exhaust the retry budget.
     */
    @Synchronized
    fun forgiveLastAttempt() {
        if (attempts.isNotEmpty()) attempts.removeLast()
        suspendedUntilMs = 0L
    }

    @Synchronized
    fun isSuspended(nowMs: Long): Boolean = nowMs < suspendedUntilMs

    @Synchronized
    fun suspendedUntilMs(): Long = suspendedUntilMs

    /** Attempts inside the current window — what the UI reports. */
    @Synchronized
    fun attemptsInWindow(nowMs: Long): Int {
        prune(nowMs)
        return attempts.size
    }

    /** Clears the rate limit. Only ever called for an explicit user action. */
    @Synchronized
    fun reset() {
        attempts.clear()
        quietUntilMs = 0L
        suspendedUntilMs = 0L
    }

    private fun prune(nowMs: Long) {
        while (attempts.isNotEmpty() && nowMs - attempts.first() > windowMs) {
            attempts.removeFirst()
        }
    }

    companion object {
        const val DEFAULT_MAX_ATTEMPTS = 5
        const val DEFAULT_WINDOW_MS = 5L * 60L * 1000L
        const val DEFAULT_QUIET_PERIOD_MS = 5L * 1000L
        const val DEFAULT_SUSPENSION_MS = 30L * 60L * 1000L
    }
}
