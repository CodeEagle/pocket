package dev.pocketjs.pocket_bluetooth

import org.junit.Assert.assertEquals
import org.junit.Test

class PocketBluetoothConnectionTest {
    @Test
    fun cccdFailureKeepsItsCauseWhenTheConnectionIsFenced() {
        val failure = PocketGattConnection.OperationResult.Failure(
            "hardware_bluetooth_notify",
            "Bluetooth notification configuration failed (133)",
        )

        assertEquals(
            "hardware_bluetooth_notify" to "Bluetooth notification configuration failed (133)",
            failure.disconnectCause(),
        )
        assertEquals(
            "hardware_bluetooth_disconnected" to "Bluetooth connection was released",
            PocketGattConnection.OperationResult.Success().disconnectCause(),
        )
    }
}
