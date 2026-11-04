package dev.pocketjs.pocket_sensors

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PocketSensorsSamplingTest {
    @Test
    fun mergedSnapshotRetainsEachRequestedSensorClass() {
        val snapshot = PocketSensorSnapshot()
        snapshot.update(1, 100L, listOf(1.0, 2.0, 3.0))
        snapshot.update(2, 110L, listOf(4.0, 5.0, 6.0))

        val first = snapshot.forTypes(setOf(1, 2))
        assertEquals(listOf(1.0, 2.0, 3.0), first[1]?.values)
        assertEquals(listOf(4.0, 5.0, 6.0), first[2]?.values)

        snapshot.update(1, 210L, listOf(7.0, 8.0, 9.0))
        val second = snapshot.forTypes(setOf(1, 2))
        assertEquals(listOf(7.0, 8.0, 9.0), second[1]?.values)
        assertEquals(listOf(4.0, 5.0, 6.0), second[2]?.values)
    }

    @Test
    fun streamDeadlinesAreIndependentAndMonotonic() {
        val tenHz = PocketSensorSamplingPolicy.periodNs(10)
        val sixtyHz = PocketSensorSamplingPolicy.periodNs(60)

        assertTrue(PocketSensorSamplingPolicy.isDue(1_000L, 0L, tenHz))
        assertFalse(PocketSensorSamplingPolicy.isDue(1_000L + tenHz - 1L, 1_000L, tenHz))
        assertTrue(PocketSensorSamplingPolicy.isDue(1_000L + tenHz, 1_000L, tenHz))
        assertFalse(PocketSensorSamplingPolicy.isDue(999L, 1_000L, sixtyHz))
        assertEquals(60, PocketSensorSamplingPolicy.maxHz(listOf(5, 60, 10)))
    }
}
