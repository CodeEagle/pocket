//! Lock-free single-producer/single-consumer binary transport.
//!
//! Each direction is an independent SPSC queue. A producer publishes a
//! payload by storing its write cursor with `Release`; the consumer observes
//! it with `Acquire` and releases the slot by storing its read cursor with
//! `Release`. There is no mutex or CAS loop in the data path. Role claims are
//! the only CAS operations and happen when an endpoint is attached.
//!
//! The queue is deliberately not MPMC. The endpoint token is `!Sync`, so a
//! safe Rust caller cannot share one producer/consumer token between threads.
//! C/FFI callers must still obey the same one-producer/one-consumer contract.

#[cfg(not(target_has_atomic = "32"))]
compile_error!("Pocket duplex requires target_has_atomic=\"32\"");

#[cfg(target_endian = "big")]
compile_error!("Pocket duplex ABI requires a little-endian target");

use std::cell::{Cell, UnsafeCell};
use std::marker::PhantomData;
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

pub const ABI_VERSION: u32 = 2;
pub const RING_CAPACITY: usize = 256;
pub const MESSAGE_BYTES: usize = 16;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct DuplexMessage {
    pub msg_type: u16,
    pub flags: u16,
    pub target_id: u32,
    pub arg0: f32,
    pub arg1: f32,
}

const _: () = assert!(std::mem::size_of::<DuplexMessage>() == MESSAGE_BYTES);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DuplexReservation {
    start: u32,
    count: u32,
}

impl DuplexReservation {
    pub fn count(self) -> u32 {
        self.count
    }
}

/// Padding keeps producer-owned and consumer-owned cursors on distinct cache
/// lines. Apple/aarch64 and x86_64 commonly use a 128-byte coherence sector;
/// the wider spacing avoids placing adjacent hot cursors in one sector. The
/// ring is opaque to FFI callers, so this has no ABI implication.
#[cfg(any(target_arch = "aarch64", target_arch = "x86_64"))]
#[repr(align(128))]
struct CachePadded<T>(T);

#[cfg(not(any(target_arch = "aarch64", target_arch = "x86_64")))]
#[repr(align(64))]
struct CachePadded<T>(T);

/// Opaque to FFI callers. Do not cast this to Dart `ByteData`: cursor words
/// are atomics. Use an attached role endpoint and reserve/commit or
/// peek/consume instead.
pub struct DuplexRing {
    ingress_write: CachePadded<AtomicU32>,
    ingress_read: CachePadded<AtomicU32>,
    egress_write: CachePadded<AtomicU32>,
    egress_read: CachePadded<AtomicU32>,
    closed: AtomicBool,
    ingress_producer_claimed: AtomicBool,
    ingress_consumer_claimed: AtomicBool,
    egress_producer_claimed: AtomicBool,
    egress_consumer_claimed: AtomicBool,
    ingress_slots: [UnsafeCell<DuplexMessage>; RING_CAPACITY],
    egress_slots: [UnsafeCell<DuplexMessage>; RING_CAPACITY],
}

// Safety comes from the SPSC protocol: a producer writes only a reserved
// slot, publishes it with Release, and the consumer frees it with Release
// before the producer reads the cursor with Acquire. Direct slot access is
// kept crate-private/unsafe by construction.
unsafe impl Send for DuplexRing {}
unsafe impl Sync for DuplexRing {}

impl DuplexRing {
    pub fn new_shared() -> Arc<Self> {
        Arc::new(Self {
            ingress_write: CachePadded(AtomicU32::new(0)),
            ingress_read: CachePadded(AtomicU32::new(0)),
            egress_write: CachePadded(AtomicU32::new(0)),
            egress_read: CachePadded(AtomicU32::new(0)),
            closed: AtomicBool::new(false),
            ingress_producer_claimed: AtomicBool::new(false),
            ingress_consumer_claimed: AtomicBool::new(false),
            egress_producer_claimed: AtomicBool::new(false),
            egress_consumer_claimed: AtomicBool::new(false),
            ingress_slots: std::array::from_fn(|_| UnsafeCell::new(DuplexMessage::default())),
            egress_slots: std::array::from_fn(|_| UnsafeCell::new(DuplexMessage::default())),
        })
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    /// Closing is a one-way generation boundary. It rejects new producer
    /// reservations, but an already returned reservation may still commit.
    /// Existing records remain drainable; slots are never reset/reused.
    pub fn close(&self) {
        self.closed.store(true, Ordering::Release);
    }

    fn claim(flag: &AtomicBool) -> bool {
        flag.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    fn release(flag: &AtomicBool) {
        flag.store(false, Ordering::Release);
    }

    pub fn claim_ingress_producer(self: &Arc<Self>) -> Option<IngressProducer> {
        if self.is_closed() || !Self::claim(&self.ingress_producer_claimed) {
            return None;
        }
        Some(IngressProducer {
            ring: self.clone(),
            pending: Cell::new(None),
            _not_sync: PhantomData,
        })
    }

    pub fn claim_ingress_consumer(self: &Arc<Self>) -> Option<IngressConsumer> {
        Self::claim(&self.ingress_consumer_claimed).then(|| IngressConsumer {
            ring: self.clone(),
            _not_sync: PhantomData,
        })
    }

    pub fn claim_egress_producer(self: &Arc<Self>) -> Option<EgressProducer> {
        if self.is_closed() || !Self::claim(&self.egress_producer_claimed) {
            return None;
        }
        Some(EgressProducer {
            ring: self.clone(),
            pending: Cell::new(None),
            _not_sync: PhantomData,
        })
    }

    pub fn claim_egress_consumer(self: &Arc<Self>) -> Option<EgressConsumer> {
        Self::claim(&self.egress_consumer_claimed).then(|| EgressConsumer {
            ring: self.clone(),
            pending: Cell::new(None),
            _not_sync: PhantomData,
        })
    }

    fn available(write: u32, read: u32) -> usize {
        let (write, read) = (write as usize, read as usize);
        if write >= RING_CAPACITY || read >= RING_CAPACITY {
            return 0;
        }
        (read + RING_CAPACITY - write - 1) % RING_CAPACITY
    }

    /// Reserve a contiguous batch. The caller owns the producer token, so no
    /// CAS is required here; only the publish/read cursors are atomic.
    fn reserve(
        &self,
        write: &CachePadded<AtomicU32>,
        read: &CachePadded<AtomicU32>,
        max_count: u32,
    ) -> Option<DuplexReservation> {
        if max_count == 0 || self.is_closed() {
            return None;
        }
        let start = write.0.load(Ordering::Relaxed);
        let free = Self::available(start, read.0.load(Ordering::Acquire));
        let count = free
            .min(RING_CAPACITY - start as usize)
            .min(max_count as usize) as u32;
        (count > 0).then_some(DuplexReservation { start, count })
    }

    /// Publish exactly the reservation returned by the same producer token.
    /// `close` is intentionally not checked: close linearizes only against
    /// new reservations, and an in-flight payload is allowed to finish.
    fn commit(&self, write: &CachePadded<AtomicU32>, reservation: DuplexReservation) -> bool {
        if reservation.start >= RING_CAPACITY as u32
            || reservation.count == 0
            || (reservation.count as usize) >= RING_CAPACITY
        {
            return false;
        }
        if write.0.load(Ordering::Relaxed) != reservation.start {
            return false;
        }
        write.0.store(
            (reservation.start + reservation.count) % RING_CAPACITY as u32,
            Ordering::Release,
        );
        true
    }

    fn payload_ptr(slots: &[UnsafeCell<DuplexMessage>; RING_CAPACITY], start: u32) -> *mut u8 {
        debug_assert!(start < RING_CAPACITY as u32);
        slots[start as usize].get().cast::<u8>()
    }

    fn peek(
        &self,
        write: &CachePadded<AtomicU32>,
        read: &CachePadded<AtomicU32>,
        slots: &[UnsafeCell<DuplexMessage>; RING_CAPACITY],
    ) -> Option<DuplexMessage> {
        let read_idx = read.0.load(Ordering::Relaxed);
        let write_idx = write.0.load(Ordering::Acquire);
        if read_idx >= RING_CAPACITY as u32
            || write_idx >= RING_CAPACITY as u32
            || read_idx == write_idx
        {
            return None;
        }
        Some(unsafe { *slots[read_idx as usize].get() })
    }

    fn peek_ptr(
        &self,
        write: &CachePadded<AtomicU32>,
        read: &CachePadded<AtomicU32>,
        slots: &[UnsafeCell<DuplexMessage>; RING_CAPACITY],
        max_count: u32,
    ) -> Option<(*const u8, u32)> {
        if max_count == 0 {
            return None;
        }
        let read_idx = read.0.load(Ordering::Relaxed);
        let write_idx = write.0.load(Ordering::Acquire);
        if read_idx >= RING_CAPACITY as u32
            || write_idx >= RING_CAPACITY as u32
            || read_idx == write_idx
        {
            return None;
        }
        let available = (write_idx + RING_CAPACITY as u32 - read_idx) % RING_CAPACITY as u32;
        let count = available.min((RING_CAPACITY as u32 - read_idx).min(max_count));
        Some((Self::payload_ptr(slots, read_idx) as *const u8, count))
    }

    fn consume(
        &self,
        write: &CachePadded<AtomicU32>,
        read: &CachePadded<AtomicU32>,
        count: u32,
    ) -> bool {
        if count == 0 || (count as usize) >= RING_CAPACITY {
            return false;
        }
        let current = read.0.load(Ordering::Relaxed);
        let published = write.0.load(Ordering::Acquire);
        if current >= RING_CAPACITY as u32 || published >= RING_CAPACITY as u32 {
            return false;
        }
        let available = (published + RING_CAPACITY as u32 - current) % RING_CAPACITY as u32;
        if available < count {
            return false;
        }
        read.0
            .store((current + count) % RING_CAPACITY as u32, Ordering::Release);
        true
    }
}

/// A producer token is intentionally `!Sync`: it can move to its worker
/// thread, but cannot be shared by two producers through a safe Rust ref.
pub struct IngressProducer {
    ring: Arc<DuplexRing>,
    pending: Cell<Option<DuplexReservation>>,
    _not_sync: PhantomData<Cell<()>>,
}

pub struct IngressConsumer {
    ring: Arc<DuplexRing>,
    _not_sync: PhantomData<Cell<()>>,
}

pub struct EgressProducer {
    ring: Arc<DuplexRing>,
    pending: Cell<Option<DuplexReservation>>,
    _not_sync: PhantomData<Cell<()>>,
}

pub struct EgressConsumer {
    ring: Arc<DuplexRing>,
    pending: Cell<Option<u32>>,
    _not_sync: PhantomData<Cell<()>>,
}

impl IngressProducer {
    pub(crate) fn reserve(&self, max_count: u32) -> Option<DuplexReservation> {
        if self.pending.get().is_some() {
            return None;
        }
        let reservation =
            self.ring
                .reserve(&self.ring.ingress_write, &self.ring.ingress_read, max_count)?;
        self.pending.set(Some(reservation));
        Some(reservation)
    }

    /// The pointer is valid only until this token commits or is dropped. The
    /// caller must write exactly `reservation.count()` messages before commit.
    pub(crate) fn payload_ptr(&self, reservation: DuplexReservation) -> Option<*mut u8> {
        (self.pending.get() == Some(reservation) && reservation.start < RING_CAPACITY as u32)
            .then(|| DuplexRing::payload_ptr(&self.ring.ingress_slots, reservation.start))
    }

    pub(crate) fn commit(&self, reservation: DuplexReservation) -> bool {
        if self.pending.get() != Some(reservation) {
            return false;
        }
        if self.ring.commit(&self.ring.ingress_write, reservation) {
            self.pending.set(None);
            true
        } else {
            false
        }
    }

    pub(crate) fn commit_count(&self, count: u32) -> bool {
        let Some(reservation) = self.pending.get() else {
            return false;
        };
        if reservation.count() != count {
            return false;
        }
        self.commit(reservation)
    }
}

impl IngressConsumer {
    pub(crate) fn peek(&self) -> Option<DuplexMessage> {
        self.ring.peek(
            &self.ring.ingress_write,
            &self.ring.ingress_read,
            &self.ring.ingress_slots,
        )
    }

    #[cfg(test)]
    #[allow(dead_code)]
    pub(crate) fn peek_ptr(&self, max_count: u32) -> Option<(*const u8, u32)> {
        self.ring.peek_ptr(
            &self.ring.ingress_write,
            &self.ring.ingress_read,
            &self.ring.ingress_slots,
            max_count,
        )
    }

    pub(crate) fn consume(&self, count: u32) -> bool {
        self.ring
            .consume(&self.ring.ingress_write, &self.ring.ingress_read, count)
    }

    pub(crate) fn consume_one(&self) -> bool {
        self.consume(1)
    }
}

impl EgressProducer {
    pub(crate) fn reserve(&self, max_count: u32) -> Option<DuplexReservation> {
        if self.pending.get().is_some() {
            return None;
        }
        let reservation =
            self.ring
                .reserve(&self.ring.egress_write, &self.ring.egress_read, max_count)?;
        self.pending.set(Some(reservation));
        Some(reservation)
    }

    pub(crate) fn payload_ptr(&self, reservation: DuplexReservation) -> Option<*mut u8> {
        (self.pending.get() == Some(reservation) && reservation.start < RING_CAPACITY as u32)
            .then(|| DuplexRing::payload_ptr(&self.ring.egress_slots, reservation.start))
    }

    pub(crate) fn commit(&self, reservation: DuplexReservation) -> bool {
        if self.pending.get() != Some(reservation) {
            return false;
        }
        if self.ring.commit(&self.ring.egress_write, reservation) {
            self.pending.set(None);
            true
        } else {
            false
        }
    }

    pub(crate) fn push(&self, message: DuplexMessage) -> bool {
        let Some(reservation) = self.reserve(1) else {
            return false;
        };
        let Some(payload) = self.payload_ptr(reservation) else {
            return false;
        };
        unsafe {
            ptr::write(payload.cast::<DuplexMessage>(), message);
        }
        self.commit(reservation)
    }
}

impl EgressConsumer {
    pub(crate) fn peek(&self, max_count: u32) -> Option<(*const u8, u32)> {
        // A borrowed span cannot be widened or replaced until it is
        // consumed. Reject a duplicate peek rather than expanding a pointer
        // whose lifetime the caller may already be using.
        if self.pending.get().is_some() {
            return None;
        }
        let span = self.ring.peek_ptr(
            &self.ring.egress_write,
            &self.ring.egress_read,
            &self.ring.egress_slots,
            max_count,
        )?;
        self.pending.set(Some(span.1));
        Some(span)
    }

    pub(crate) fn consume(&self, count: u32) -> bool {
        if self.pending.get() != Some(count) {
            return false;
        }
        if self
            .ring
            .consume(&self.ring.egress_write, &self.ring.egress_read, count)
        {
            self.pending.set(None);
            true
        } else {
            false
        }
    }
}

impl Drop for IngressProducer {
    fn drop(&mut self) {
        // A dropped reservation may still have a caller-held payload pointer.
        // Poison/close this generation instead of allowing a replacement
        // producer to reuse and overwrite that slot.
        if self.pending.get().is_some() {
            self.ring.close();
        }
        DuplexRing::release(&self.ring.ingress_producer_claimed);
    }
}

impl Drop for IngressConsumer {
    fn drop(&mut self) {
        DuplexRing::release(&self.ring.ingress_consumer_claimed);
    }
}

impl Drop for EgressProducer {
    fn drop(&mut self) {
        if self.pending.get().is_some() {
            self.ring.close();
        }
        DuplexRing::release(&self.ring.egress_producer_claimed);
    }
}

impl Drop for EgressConsumer {
    fn drop(&mut self) {
        if self.pending.get().is_some() {
            // A caller may still hold the borrowed egress payload. Do not
            // release the role and let a replacement producer reuse it.
            self.ring.close();
        }
        DuplexRing::release(&self.ring.egress_consumer_claimed);
    }
}
