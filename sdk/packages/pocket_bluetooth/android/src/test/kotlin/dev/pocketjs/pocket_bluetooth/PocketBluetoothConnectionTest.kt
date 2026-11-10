package dev.pocketjs.pocket_bluetooth

import android.bluetooth.BluetoothProfile
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
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

    @Test
    fun onlyNativeDisconnectedStateConfirmsGattClose() {
        assertFalse(isNativeBleDisconnectConfirmation(BluetoothProfile.STATE_CONNECTED))
        assertFalse(isNativeBleDisconnectConfirmation(BluetoothProfile.STATE_DISCONNECTING))
        assertTrue(isNativeBleDisconnectConfirmation(BluetoothProfile.STATE_DISCONNECTED))
    }
}
