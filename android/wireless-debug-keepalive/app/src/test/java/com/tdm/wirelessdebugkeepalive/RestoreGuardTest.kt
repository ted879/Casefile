package com.tdm.wirelessdebugkeepalive

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RestoreGuardTest {

    private fun guard() = RestoreGuard(
        maxAttemptsInWindow = 3,
        windowMs = 60_000L,
        quietPeriodMs = 5_000L,
        suspensionMs = 600_000L,
    )

    @Test
    fun `allows a restore when nothing has happened yet`() {
        assertEquals(RestoreGuard.Decision.ALLOW, guard().evaluate(1_000L))
    }

    @Test
    fun `debounces immediately after a restore`() {
        val g = guard()
        g.recordAttempt(1_000L)
        assertEquals(RestoreGuard.Decision.IN_QUIET_PERIOD, g.evaluate(2_000L))
        assertEquals(RestoreGuard.Decision.IN_QUIET_PERIOD, g.evaluate(5_999L))
        assertEquals(RestoreGuard.Decision.ALLOW, g.evaluate(6_001L))
    }

    @Test
    fun `suspends after too many restores inside the window`() {
        val g = guard()
        assertFalse(g.recordAttempt(0L))
        assertFalse(g.recordAttempt(10_000L))
        assertTrue("third restore inside the window trips the limit", g.recordAttempt(20_000L))
        assertEquals(RestoreGuard.Decision.SUSPENDED, g.evaluate(30_000L))
        assertTrue(g.isSuspended(30_000L))
    }

    @Test
    fun `suspension expires after the cooldown`() {
        val g = guard()
        g.recordAttempt(0L)
        g.recordAttempt(10_000L)
        g.recordAttempt(20_000L)
        assertTrue(g.isSuspended(100_000L))
        assertFalse(g.isSuspended(20_000L + 600_000L + 1L))
        assertEquals(RestoreGuard.Decision.ALLOW, g.evaluate(20_000L + 600_000L + 1L))
    }

    @Test
    fun `attempts outside the window do not count toward the limit`() {
        val g = guard()
        g.recordAttempt(0L)
        g.recordAttempt(10_000L)
        // Far outside the 60s window: the two earlier attempts are pruned.
        assertFalse(g.recordAttempt(200_000L))
        assertEquals(1, g.attemptsInWindow(200_000L))
        assertFalse(g.isSuspended(200_000L))
    }

    @Test
    fun `reset clears the quiet period and the suspension`() {
        val g = guard()
        g.recordAttempt(0L)
        g.recordAttempt(10_000L)
        g.recordAttempt(20_000L)
        assertTrue(g.isSuspended(21_000L))
        g.reset()
        assertFalse(g.isSuspended(21_000L))
        assertEquals(RestoreGuard.Decision.ALLOW, g.evaluate(21_000L))
        assertEquals(0, g.attemptsInWindow(21_000L))
    }

    @Test
    fun `a sustained fight with the system stays suspended rather than looping`() {
        val g = guard()
        var now = 0L
        var writes = 0
        // Android turns it back off every second for five minutes.
        repeat(300) {
            if (g.evaluate(now) == RestoreGuard.Decision.ALLOW) {
                g.recordAttempt(now)
                writes++
            }
            now += 1_000L
        }
        assertEquals("the guard must cap the number of writes", 3, writes)
    }
}
