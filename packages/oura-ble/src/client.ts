/** Opaque peripheral identifier returned by discovery. */
export type OuraPeripheralId = string;

/** SDK pairing identifier returned after successful pairing. */
export type OuraRingId = string;

/** Store-local opaque continuation token for event paging. */
export type OuraEventPageToken = string;

/** Ring-relative timestamp as reported by the ring/protocol. */
export interface OuraRingRelativeTimestamp {
  /** Ring clock value in the reported unit. The iOS adapter uses milliseconds. */
  value: number;
  /** Unit of the raw value (for example "ticks" or "seconds"). */
  unit: string;
  /** Optional clock/session context used to resolve observation times. */
  context?: string;
}

/** Time when the host/SDK captured or received the event. */
export type OuraCaptureTimestamp = string;

/** Decoded event fields when available; structure depends on event type. */
export type OuraDecodedEventFields = Record<string, unknown>;

/** A recorded ring event returned by sync/read APIs. */
export interface OuraEvent {
  /** Ring identity associated with this event (SDK pairing/ring identifier). */
  ringId: OuraRingId;
  /** Numeric event tag from the ring packet, including tags the decoder does not recognize. */
  tag: number;
  /** Event type identifier. */
  eventType: string;
  /** Timestamp relative to the ring's clock. */
  ringRelativeTimestamp: OuraRingRelativeTimestamp;
  /** Capture/receipt time for this event. */
  captureTime: OuraCaptureTimestamp;
  /** Decoded fields when available. */
  decodedFields?: OuraDecodedEventFields;
  /**
   * Raw event body encoded as a base64 string.
   * This preserves the original bytes for consumers that need them.
   */
  rawBodyBase64: string;
}

/** A ring discovered over Bluetooth. */
export interface OuraDiscoveredRing {
  /** Opaque peripheral identifier to pass to pairing. */
  peripheralId: OuraPeripheralId;
  /** Optional advertised name. */
  name?: string | null;
}

/** Device information returned after pairing. */
export interface OuraDeviceInfo {
  /** Optional hardware/model identifier. */
  model?: string | null;
  /** Optional firmware version. */
  firmwareVersion?: string | null;
  /** Optional hardware revision. */
  hardwareRevision?: string | null;
  /** Ring serial verified during pairing. */
  serialNumber: string;
}

/** Outcome of a requested measurement setting change. */
export interface OuraMeasurementOutcome {
  /** Measurement setting identifier. */
  setting: string;
  /** Whether the ring accepted or applied the setting. */
  accepted: boolean;
  /** Optional reason or detail from the adapter/protocol. */
  reason?: string | null;
}

/** Options for pairing a discovered ring. */
export interface OuraPairOptions {
  /** Measurement settings to request during setup. */
  requestedMeasurements?: string[];
}

/** Result of pairing a ring. */
export interface OuraPairResult {
  /** New SDK pairing identifier for the ring. */
  ringId: OuraRingId;
  /** Device information obtained during pairing. */
  deviceInfo: OuraDeviceInfo;
  /** Outcomes for any requested measurement settings. */
  measurementOutcomes: OuraMeasurementOutcome[];
}

/** Result of a foreground sync operation. */
export interface OuraSyncResult {
  /** Ring that was synced. */
  ringId: OuraRingId;
  /** Number of new event records committed during sync. */
  syncedEventCount: number;
  /** Optional details about preparation or clock anchors. */
  warnings?: string[];
}

/** Options for reading recorded events. */
export interface OuraReadEventsOptions {
  /** Opaque continuation token from a previous page. */
  pageToken?: OuraEventPageToken;
  /** Optional maximum number of events to return. */
  limit?: number;
}

/** A page of recorded events. */
export interface OuraEventPage {
  /** Events in this page. */
  events: OuraEvent[];
  /** Opaque continuation token for the next page, if more events exist. */
  nextPageToken?: OuraEventPageToken | null;
}

/**
 * Portable public client contract for Oura Ring Bluetooth pairing and sync.
 *
 * Implementations are provided by platform adapters (for example the Expo
 * entry point). Host apps own UI, account association, uploads, and derived
 * metrics.
 */
export interface OuraClient {
  /** Discover nearby rings and return opaque peripheral identifiers. */
  discoverRings(): Promise<OuraDiscoveredRing[]>;

  /**
   * Pair with a discovered ring.
   * Returns a new SDK pairing identifier, device information, and requested
   * measurement outcomes.
   */
  pairRing(peripheralId: OuraPeripheralId, options?: OuraPairOptions): Promise<OuraPairResult>;

  /** Sync recorded history for an already-paired ring. */
  syncRing(ringId: OuraRingId): Promise<OuraSyncResult>;

  /** Read recorded events with store-local opaque paging. */
  readEvents(ringId: OuraRingId, options?: OuraReadEventsOptions): Promise<OuraEventPage>;

  /** Remove this app's local data and pairing credentials for a ring. */
  forgetRing(ringId: OuraRingId): Promise<void>;
}
