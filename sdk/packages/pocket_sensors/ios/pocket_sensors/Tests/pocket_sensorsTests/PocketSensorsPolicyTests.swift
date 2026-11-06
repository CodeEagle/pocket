import XCTest
@testable import pocket_sensors

final class PocketSensorsPolicyTests: XCTestCase {
  func testPerStreamMonotonicDeadline() {
    XCTAssertTrue(
      PocketSensorSamplingPolicy.isDue(
        nowNanoseconds: 1_000,
        lastEmissionNanoseconds: 0,
        samplingHz: 10
      )
    )
    XCTAssertFalse(
      PocketSensorSamplingPolicy.isDue(
        nowNanoseconds: 1_099_999_999,
        lastEmissionNanoseconds: 1_000_000_000,
        samplingHz: 10
      )
    )
    XCTAssertTrue(
      PocketSensorSamplingPolicy.isDue(
        nowNanoseconds: 1_100_000_000,
        lastEmissionNanoseconds: 1_000_000_000,
        samplingHz: 10
      )
    )
    // Wall-clock regressions or a late callback cannot bypass the gate.
    XCTAssertFalse(
      PocketSensorSamplingPolicy.isDue(
        nowNanoseconds: 999,
        lastEmissionNanoseconds: 1_000,
        samplingHz: 60
      )
    )
  }

  func testRateIsBoundedToSupportedRange() {
    XCTAssertEqual(PocketSensorSamplingPolicy.periodNanoseconds(hz: 0), 1_000_000_000)
    XCTAssertEqual(PocketSensorSamplingPolicy.periodNanoseconds(hz: 120), 16_666_667)
  }
}
