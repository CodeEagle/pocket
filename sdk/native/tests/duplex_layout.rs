#[path = "../src/duplex.rs"]
mod duplex;

use duplex::{DuplexMessage, DuplexRing, MESSAGE_BYTES, RING_CAPACITY};
use std::collections::VecDeque;
use std::hint::black_box;
use std::mem::size_of;
use std::ptr;
use std::sync::{Arc, Barrier, Mutex};
use std::thread;
use std::time::Instant;

#[test]
fn abi_v2_message_layout_is_stable_and_ring_is_opaque() {
    assert_eq!(size_of::<DuplexMessage>(), MESSAGE_BYTES);
    // ABI v2 deliberately does not promise a Rust struct layout to Dart.
    assert_ne!(size_of::<DuplexRing>(), 8216);
    assert_eq!(duplex::ABI_VERSION, 2);
}

#[test]
fn role_claim_is_single_producer_single_consumer() {
    let ring = DuplexRing::new_shared();
    let producer = ring.claim_ingress_producer().expect("first producer");
    assert!(ring.claim_ingress_producer().is_none());
    let consumer = ring.claim_ingress_consumer().expect("first consumer");
    assert!(ring.claim_ingress_consumer().is_none());
    drop(producer);
    assert!(ring.claim_ingress_producer().is_some());
    drop(consumer);
}

#[test]
fn full_queue_does_not_overwrite_and_slot_reuse_follows_consume() {
    let ring = DuplexRing::new_shared();
    let producer = ring.claim_egress_producer().unwrap();
    let consumer = ring.claim_egress_consumer().unwrap();

    for index in 0..(RING_CAPACITY - 1) {
        assert!(producer.push(DuplexMessage {
            msg_type: index as u16,
            ..DuplexMessage::default()
        }));
    }
    assert!(producer.push(DuplexMessage::default()) == false);
    let (payload, count) = consumer.peek(1).unwrap();
    assert_eq!(count, 1);
    assert_eq!(unsafe { (*payload.cast::<DuplexMessage>()).msg_type }, 0);
    assert!(consumer.peek(RING_CAPACITY as u32).is_none());
    assert!(!consumer.consume(2));

    assert!(consumer.consume(1));
    assert!(producer.push(DuplexMessage {
        msg_type: 0xbeef,
        ..DuplexMessage::default()
    }));
    let (payload, count) = consumer.peek(RING_CAPACITY as u32).unwrap();
    assert_eq!(count as usize, RING_CAPACITY - 1);
    assert_eq!(unsafe { (*payload.cast::<DuplexMessage>()).msg_type }, 1);
}

#[test]
fn close_rejects_new_reservations_but_allows_in_flight_commit_and_drain() {
    let ring = DuplexRing::new_shared();
    let producer = ring.claim_ingress_producer().unwrap();
    let consumer = ring.claim_ingress_consumer().unwrap();
    let reservation = producer.reserve(1).unwrap();
    unsafe {
        ptr::write(
            producer
                .payload_ptr(reservation)
                .unwrap()
                .cast::<DuplexMessage>(),
            DuplexMessage {
                msg_type: 123,
                ..DuplexMessage::default()
            },
        );
    }
    ring.close();
    assert!(producer.commit_count(reservation.count()));
    assert!(producer.reserve(1).is_none());
    assert_eq!(consumer.peek().unwrap().msg_type, 123);
    assert!(consumer.consume_one());
    assert!(consumer.peek().is_none());
}

#[test]
fn close_race_preserves_in_flight_payload_and_generation_is_not_reused() {
    let old = DuplexRing::new_shared();
    let producer = old.claim_ingress_producer().unwrap();
    let consumer = old.claim_ingress_consumer().unwrap();
    let barrier = Arc::new(Barrier::new(2));
    let close_barrier = barrier.clone();
    let close_ring = old.clone();
    let closer = thread::spawn(move || {
        close_barrier.wait();
        close_ring.close();
    });
    let reservation = producer.reserve(1).unwrap();
    unsafe {
        ptr::write(
            producer
                .payload_ptr(reservation)
                .unwrap()
                .cast::<DuplexMessage>(),
            DuplexMessage {
                target_id: 0xdead_beef,
                ..DuplexMessage::default()
            },
        );
    }
    barrier.wait();
    assert!(producer.commit(reservation));
    closer.join().unwrap();
    assert!(old.is_closed());
    assert_eq!(consumer.peek().unwrap().target_id, 0xdead_beef);

    // Reload creates a different Arc generation; it never clears or reuses
    // the old generation's slots while a retained handle can still drain it.
    let fresh = DuplexRing::new_shared();
    let fresh_producer = fresh.claim_egress_producer().unwrap();
    assert!(fresh_producer.push(DuplexMessage {
        target_id: 7,
        ..DuplexMessage::default()
    }));
    assert!(!Arc::ptr_eq(&old, &fresh));
}

#[test]
fn concurrent_million_sequence_wrap_has_no_loss_or_overwrite() {
    const TOTAL: u32 = 1_000_000;
    let ring = DuplexRing::new_shared();
    let producer = ring.claim_ingress_producer().unwrap();
    let consumer = ring.claim_ingress_consumer().unwrap();
    let producer_thread = thread::spawn(move || {
        let mut next = 0_u32;
        while next < TOTAL {
            let remaining = TOTAL - next;
            let Some(reservation) = producer.reserve(remaining.min(64)) else {
                thread::yield_now();
                continue;
            };
            let count = reservation.count();
            let payload = producer
                .payload_ptr(reservation)
                .unwrap()
                .cast::<DuplexMessage>();
            for offset in 0..count {
                unsafe {
                    ptr::write(
                        payload.add(offset as usize),
                        DuplexMessage {
                            target_id: next + offset,
                            msg_type: (next + offset) as u16,
                            ..DuplexMessage::default()
                        },
                    );
                }
            }
            assert!(producer.commit(reservation));
            next += count;
        }
    });
    let consumer_thread = thread::spawn(move || {
        let mut expected = 0_u32;
        while expected < TOTAL {
            let Some((payload, count)) = consumer.peek_ptr(64) else {
                thread::yield_now();
                continue;
            };
            let payload = payload.cast::<DuplexMessage>();
            for offset in 0..count {
                let message = unsafe { *payload.add(offset as usize) };
                assert_eq!(message.target_id, expected + offset);
                assert_eq!(message.msg_type, (expected + offset) as u16);
            }
            assert!(consumer.consume(count));
            expected += count;
        }
    });
    producer_thread.join().unwrap();
    consumer_thread.join().unwrap();
}

/// A deliberately ignored smoke benchmark. It reports the lock-free SPSC
/// path beside a same-16-byte two-thread Mutex<VecDeque> baseline for several
/// batch sizes. It is not a claim of speedup: both results depend on the
/// machine, scheduler, cache state and debug/release profile. No p95 latency
/// or allocation profile is measured here.
#[test]
#[ignore = "manual throughput comparison"]
fn throughput_report_lock_free_vs_mutex_baseline() {
    const TOTAL: u32 = 1_000_000;
    for batch in [1_u32, 16, 64, 255] {
        let ring = DuplexRing::new_shared();
        let producer = ring.claim_ingress_producer().unwrap();
        let consumer = ring.claim_ingress_consumer().unwrap();
        let started = Instant::now();
        let producer_thread = thread::spawn(move || {
            let mut next = 0_u32;
            while next < TOTAL {
                let Some(reservation) = producer.reserve(batch.min(TOTAL - next)) else {
                    thread::yield_now();
                    continue;
                };
                let count = reservation.count();
                let payload = producer
                    .payload_ptr(reservation)
                    .unwrap()
                    .cast::<DuplexMessage>();
                for offset in 0..count {
                    unsafe {
                        ptr::write(
                            payload.add(offset as usize),
                            DuplexMessage {
                                target_id: next + offset,
                                ..DuplexMessage::default()
                            },
                        );
                    }
                }
                assert!(producer.commit(reservation));
                next += count;
            }
        });
        let consumer_thread = thread::spawn(move || {
            let mut expected = 0_u32;
            while expected < TOTAL {
                let Some((payload, count)) = consumer.peek_ptr(batch) else {
                    thread::yield_now();
                    continue;
                };
                let payload = payload.cast::<DuplexMessage>();
                for offset in 0..count {
                    let message = unsafe { *payload.add(offset as usize) };
                    assert_eq!(message.target_id, expected + offset);
                    black_box(message);
                }
                assert!(consumer.consume(count));
                expected += count;
            }
        });
        producer_thread.join().unwrap();
        consumer_thread.join().unwrap();
        let lock_free = started.elapsed();

        let queue = Arc::new(Mutex::new(VecDeque::<DuplexMessage>::with_capacity(
            RING_CAPACITY - 1,
        )));
        let producer_queue = queue.clone();
        let started = Instant::now();
        let producer_thread = thread::spawn(move || {
            let mut next = 0_u32;
            while next < TOTAL {
                let mut published = false;
                let mut count = 0_u32;
                while !published {
                    let mut queue = producer_queue.lock().unwrap();
                    let free = (RING_CAPACITY - 1 - queue.len()) as u32;
                    count = batch.min(TOTAL - next).min(free);
                    if count > 0 {
                        for offset in 0..count {
                            queue.push_back(DuplexMessage {
                                target_id: next + offset,
                                ..DuplexMessage::default()
                            });
                        }
                        published = true;
                    }
                    drop(queue);
                    if !published {
                        thread::yield_now();
                    }
                }
                next += count;
            }
        });
        let consumer_queue = queue;
        let consumer_thread = thread::spawn(move || {
            let mut expected = 0_u32;
            while expected < TOTAL {
                let mut consumed = 0_u32;
                {
                    let mut queue = consumer_queue.lock().unwrap();
                    while consumed < batch {
                        let Some(message) = queue.pop_front() else {
                            break;
                        };
                        assert_eq!(message.target_id, expected + consumed);
                        black_box(message);
                        consumed += 1;
                    }
                }
                if consumed == 0 {
                    thread::yield_now();
                } else {
                    expected += consumed;
                }
            }
        });
        producer_thread.join().unwrap();
        consumer_thread.join().unwrap();
        let mutex = started.elapsed();
        eprintln!("batch={batch}: lock-free={lock_free:?}; mutex_vecdeque={mutex:?}");
    }
}
