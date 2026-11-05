#!/usr/bin/env python3
"""Exercise real native PFB1/PFP1 wire lengths; no guest JSON helpers."""
import ctypes
import struct
import sys


def run(library_path):
    lib = ctypes.CDLL(library_path)
    host_type = ctypes.c_void_p
    lib.pocket_create.argtypes = [ctypes.c_double, ctypes.c_double]
    lib.pocket_create.restype = host_type
    lib.pocket_destroy.argtypes = [host_type]
    lib.pocket_eval.argtypes = [host_type, ctypes.c_char_p]
    lib.pocket_eval.restype = ctypes.c_int
    lib.pocket_send_binary.argtypes = [host_type, ctypes.c_char_p, ctypes.c_size_t]
    lib.pocket_send_binary.restype = ctypes.c_int
    lib.pocket_frame_delta_binary_v2.argtypes = [host_type, ctypes.c_double, ctypes.c_uint64, ctypes.POINTER(ctypes.c_uint64)]
    lib.pocket_frame_delta_binary_v2.restype = ctypes.c_void_p
    host = lib.pocket_create(640, 480)
    assert host, "native host allocation failed"
    try:
        source = b"""
          const rects = []; let mounted = false;
          globalThis.frame = function() {
            if (mounted) return; mounted = true;
            for (let i=0; i<100; i++) {
              const n = ui.createNode(0);
              ui.setProp(n,1,16); ui.setProp(n,2,16); ui.setProp(n,24,1);
              ui.setProp(n,28,4+(i%10)*24); ui.setProp(n,25,4+Math.floor(i/10)*24);
              ui.setProp(n,64,0xff204060+i); ui.insertBefore(1,n,0); rects.push(n);
            }
          };
          globalThis.__pocketEvent = function(packet) {
            if (typeof packet !== 'object' || packet.name !== 'bump') throw Error('not a direct object');
            ui.setProp(rects[50],64,0xffcc6633);
          };
          __pocketEvent.__binaryCapable = true;
          JSON.parse = JSON.stringify = function(){throw Error('JSON reached frame transport');};
        """
        assert lib.pocket_eval(host, source) == 0, "guest evaluation failed"

        def frame(base, delta=0):
            length = ctypes.c_uint64()
            pointer = lib.pocket_frame_delta_binary_v2(host, delta, base, ctypes.byref(length))
            assert bool(pointer) == bool(length.value), "pointer/length contract mismatch"
            return ctypes.string_at(pointer, length.value) if pointer else b""

        first = frame(0, 17)
        assert first[:4] == b'PFB1', "first frame must resynchronize in full"
        assert struct.unpack_from('<I', first, 24)[0] == 100
        sequence = struct.unpack_from('<Q', first, 8)[0]
        idle = frame(sequence)
        assert not idle, "idle frame must transfer zero bytes"
        # B1 object {type: 'event', name: 'bump', payload: {}}.
        def string(value):
            data = value.encode('utf8')
            return struct.pack('<I', len(data)) + data
        packet = b'\xb1\x08' + struct.pack('<I', 3)
        packet += string('type') + b'\x05' + string('event')
        packet += string('name') + b'\x05' + string('bump')
        packet += string('payload') + b'\x08' + struct.pack('<I', 0)
        assert lib.pocket_send_binary(host, packet, len(packet)) == 0
        changed = frame(sequence)
        assert changed[:4] == b'PFP1', "single change must use the increment protocol"
        assert len(changed) < len(first)
        assert struct.unpack_from('<Q', changed, 4)[0] == sequence
        assert struct.unpack_from('<IIII', changed, 12) == (50, 1, 100, len(changed) - 28)
        assert changed[28:32] == b'PFB1'
        assert struct.unpack_from('<I', changed, 52)[0] == 1, "splice must insert one changed op"
        resync = frame(0)
        assert resync[:4] == b'PFB1', "stale baseline must recover with a full frame"
        print(f'PFB1 initial={len(first)} B; idle={len(idle)} B; PFP1 one-change={len(changed)} B; stale-resync={len(resync)} B')
    finally:
        lib.pocket_destroy(host)


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('usage: probe_frame_transport.py <native-dylib-or-so>')
    run(sys.argv[1])
