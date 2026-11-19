use std::time::{Duration, SystemTime, UNIX_EPOCH};

use oura_link::transport::Transport;
use oura_protocol::events::{EventBatchSummary, ExtEventBatchSummary, event_name};
use oura_protocol::protocol::{self, HISTORY_EVENT_PREFIX, Packet};
use oura_store::storage::{Store, decode_stored_event};
use rusqlite::{Connection, OptionalExtension, params};

use crate::{Result, operation};

const EXTENDED_BATCH_SIZE: u16 = 4096;
const LEGACY_BATCH_SIZE: u8 = 255;
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(6);
const MAX_TIMESTAMP_MS: u64 = (u32::MAX as u64) * 100;
const STORE_VERSION: u32 = 1;

pub(crate) fn has_clock_anchor(path: &str, serial: &str) -> Result<bool> {
    let db = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(storage_error)?;
    db.query_row(
        "SELECT EXISTS (
            SELECT 1 FROM events
            WHERE serial = ?1 AND tag IN (0x42, 0x85) AND decoded_json IS NOT NULL
        )",
        [serial],
        |row| row.get(0),
    )
    .map_err(storage_error)
}

struct Event {
    tag: u8,
    timestamp_ms: u64,
    body: Vec<u8>,
}

enum Fetch {
    Batch { events: Vec<Event>, bytes_left: u32 },
    ExtendedUnsupported,
    CursorRejected,
}

pub(crate) async fn sync_to_store(
    transport: &impl Transport,
    path: &str,
    serial: &str,
) -> Result<u32> {
    // Reuse open_oura's event schema and body decoders. Its storage API takes
    // u32 deciseconds, so write millisecond timestamps and the cursor together
    // through our own transaction. Only this SDK opens these private databases.
    Store::open(path)
        .map_err(|error| operation(format!("Could not open the event store: {error}")))?;
    let mut db = Connection::open(path).map_err(storage_error)?;
    db.execute_batch("PRAGMA synchronous=FULL;")
        .map_err(storage_error)?;
    migrate_store(&mut db).map_err(storage_error)?;
    let mut cursor = db
        .query_row(
            "SELECT next_cursor FROM sync_state WHERE serial = ?1",
            [serial],
            |row| row.get(0),
        )
        .optional()
        .map_err(storage_error)?
        .unwrap_or(0);
    let mut extended = true;
    let mut inserted = 0;
    let mut tail_passes = 0;
    let mut check_stale = cursor > 0;
    for _ in 0..100_000 {
        let batch = read_batch(transport, cursor, &mut extended).await?;
        match batch {
            Fetch::CursorRejected if check_stale => {
                cursor = 0;
                commit(&mut db, serial, &[], cursor).map_err(storage_error)?;
                check_stale = false;
            }
            Fetch::CursorRejected => {
                return Err(operation("The ring rejected the history cursor."));
            }
            Fetch::ExtendedUnsupported => unreachable!("read_batch handles legacy fallback"),
            Fetch::Batch {
                mut events,
                bytes_left,
            } => {
                events.retain(|event| event.timestamp_ms >= cursor);
                if check_stale && events.is_empty() {
                    // Some firmware rejects a stale cursor, while others reply
                    // with an empty batch. Check for the retained boundary event.
                    let marker = read_batch(transport, cursor - 1, &mut extended).await?;
                    if !matches!(marker, Fetch::Batch { events, .. }
                        if events.iter().any(|event| event.timestamp_ms >= cursor))
                    {
                        cursor = 0;
                        commit(&mut db, serial, &[], cursor).map_err(storage_error)?;
                        check_stale = false;
                        continue;
                    }
                }
                check_stale = false;
                let next = events
                    .iter()
                    .map(|event| event.timestamp_ms)
                    .max()
                    .unwrap_or(cursor);
                let written = commit(&mut db, serial, &events, next).map_err(storage_error)?;
                inserted += written;
                if next == cursor && written == 0 {
                    if bytes_left != 0 {
                        return Err(operation(
                            "The ring reported more history but its cursor did not advance.",
                        ));
                    }
                    return Ok(inserted);
                }
                // The boundary stays inclusive so events sharing a timestamp
                // can straddle batches. Existing records deduplicate in SQLite.
                cursor = next;
                if bytes_left == 0 && events.len() < 32 {
                    tail_passes += 1;
                    if tail_passes == 3 {
                        return Ok(inserted);
                    }
                } else {
                    tail_passes = 0;
                }
            }
        }
    }
    Err(operation(
        "The history drain exceeded its batch limit. Reconnect to resume.",
    ))
}

async fn read_batch(transport: &impl Transport, cursor: u64, extended: &mut bool) -> Result<Fetch> {
    request(transport, &protocol::req_data_flush(), |packet| {
        packet.tag == 0x29
    })
    .await?;
    if *extended {
        let batch = collect_batch(
            transport,
            &protocol::req_ext_get_event(cursor, EXTENDED_BATCH_SIZE, 0),
            true,
        )
        .await?;
        if !matches!(batch, Fetch::ExtendedUnsupported) {
            return Ok(batch);
        }
        *extended = false;
    }
    let deciseconds = u32::try_from(cursor / 100)
        .map_err(|_| operation("The saved history cursor is out of range for the ring."))?;
    collect_batch(
        transport,
        &protocol::req_get_event(deciseconds, LEGACY_BATCH_SIZE, -1),
        false,
    )
    .await
}

async fn collect_batch(
    transport: &impl Transport,
    command: &[u8],
    extended: bool,
) -> Result<Fetch> {
    let mut events = Vec::new();
    let mut envelopes = Vec::new();
    let mut terminal = None;
    request(transport, command, |packet| {
        let result = if extended {
            match packet.ext_tag() {
                Some(0x00) => Some(Ok(Fetch::ExtendedUnsupported)),
                Some(0x43) => decode_envelopes(&mut envelopes, &packet.payload[1..], &mut events)
                    .err()
                    .map(Err),
                Some(0x42) => Some(finish_extended(&packet, &mut events, &envelopes)),
                _ => None,
            }
        } else if let Some(summary) = EventBatchSummary::parse(&packet) {
            // Upstream's Horizon 3.4.3 replay can report zero with payload.
            let expected =
                (summary.events_received > 0).then_some(usize::from(summary.events_received));
            Some(finish(&mut events, expected, summary.bytes_left))
        } else if packet.tag >= HISTORY_EVENT_PREFIX {
            match packet.payload.get(..4) {
                Some(timestamp) => {
                    events.push(Event {
                        tag: packet.tag,
                        timestamp_ms: u64::from(u32::from_le_bytes(timestamp.try_into().unwrap()))
                            * 100,
                        body: packet.payload[4..].to_vec(),
                    });
                    None
                }
                None => Some(Err(operation(
                    "The ring sent a legacy event without its timestamp.",
                ))),
            }
        } else {
            None
        };
        terminal = result;
        terminal.is_some()
    })
    .await?;
    terminal.expect("the batch collector stops only on a terminal result")
}

async fn request(
    transport: &impl Transport,
    command: &[u8],
    mut receive: impl FnMut(Packet) -> bool + Send,
) -> Result<()> {
    let mut frames = transport.subscribe();
    transport
        .write(command)
        .await
        .map_err(|error| operation(format!("Could not request ring history: {error}")))?;
    loop {
        let frame = tokio::time::timeout(RESPONSE_TIMEOUT, frames.recv())
            .await
            .map_err(|_| {
                operation("The ring did not complete its history response. Reconnect to resume.")
            })?
            .map_err(|error| {
                operation(format!(
                    "The history notification stream was interrupted: {error}"
                ))
            })?;
        if Packet::parse_many(&frame).into_iter().any(&mut receive) {
            return Ok(());
        }
    }
}

fn finish_extended(packet: &Packet, events: &mut Vec<Event>, pending: &[u8]) -> Result<Fetch> {
    let summary = ExtEventBatchSummary::parse(packet)
        .ok_or_else(|| operation("The ring sent an invalid extended history summary."))?;
    match summary.result_code {
        0xff => return Ok(Fetch::CursorRejected),
        0x00 => {}
        code => {
            return Err(operation(format!(
                "The ring rejected the history request (0x{code:02x})."
            )));
        }
    }
    if !pending.is_empty() {
        return Err(operation(
            "The ring ended the batch with an incomplete event envelope.",
        ));
    }
    finish(
        events,
        Some(usize::from(summary.events_received)),
        summary.bytes_left,
    )
}

fn finish(events: &mut Vec<Event>, expected: Option<usize>, bytes_left: u32) -> Result<Fetch> {
    if let Some(expected) = expected.filter(|&count| count != events.len()) {
        return Err(operation(format!(
            "The ring reported {expected} events but received {}.",
            events.len()
        )));
    }
    Ok(Fetch::Batch {
        events: std::mem::take(events),
        bytes_left,
    })
}

fn decode_envelopes(pending: &mut Vec<u8>, chunk: &[u8], events: &mut Vec<Event>) -> Result<()> {
    pending.extend_from_slice(chunk);
    let mut offset = 0;
    while let Some([low, high]) = pending.get(offset..offset + 2) {
        let length = usize::from(u16::from_le_bytes([*low, *high]));
        let start = offset + 2;
        let Some(bundle) = pending.get(start..start + length) else {
            break;
        };
        decode_bundle(bundle, events)
            .ok_or_else(|| operation("The ring sent an invalid extended event envelope."))?;
        offset = start + length;
    }
    pending.drain(..offset);
    Ok(())
}

// open_oura converts bundles to legacy decisecond packets. Preserve the original
// millisecond values here for checkpointing, and use its body decoders in commit.
fn decode_bundle(mut bundle: &[u8], events: &mut Vec<Event>) -> Option<()> {
    let mut last_ms: Option<u64> = None;
    while !bundle.is_empty() {
        let [_, tag, length, ..] = *bundle else {
            return None;
        };
        let end = 3 + usize::from(length);
        let record = bundle.get(3..end)?;
        let (encoded, used) = read_varint(record)?;
        let timestamp_ms = match last_ms {
            Some(previous) => previous.checked_add(encoded)?,
            None => encoded,
        };
        if tag < HISTORY_EVENT_PREFIX || timestamp_ms > MAX_TIMESTAMP_MS {
            return None;
        }
        events.push(Event {
            tag,
            timestamp_ms,
            body: record[used..].to_vec(),
        });
        last_ms = Some(timestamp_ms);
        bundle = &bundle[end..];
    }
    Some(())
}

fn read_varint(bytes: &[u8]) -> Option<(u64, usize)> {
    let mut value = 0;
    for (index, byte) in bytes.iter().copied().take(10).enumerate() {
        if index == 9 && byte > 1 {
            return None;
        }
        value |= u64::from(byte & 0x7f) << (index * 7);
        if byte & 0x80 == 0 {
            return Some((value, index + 1));
        }
    }
    None
}

fn commit(
    db: &mut Connection,
    serial: &str,
    events: &[Event],
    cursor: u64,
) -> rusqlite::Result<u32> {
    let captured = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let tx = db.transaction()?;
    let mut inserted = 0;
    {
        let mut insert = tx.prepare_cached(
            "INSERT INTO events (serial, tag, name, ring_timestamp, body, decoded_json, captured_unix)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(serial, tag, ring_timestamp, body) DO NOTHING",
        )?;
        for event in events {
            inserted += insert.execute(params![
                serial,
                event.tag,
                event_name(event.tag),
                event.timestamp_ms,
                event.body,
                decode_stored_event(event.tag, &event.body, None),
                captured,
            ])? as u32;
        }
    }
    tx.execute(
        "INSERT INTO sync_state (serial, next_cursor, last_sync_unix) VALUES (?1, ?2, ?3)
         ON CONFLICT(serial) DO UPDATE SET next_cursor = excluded.next_cursor,
                                           last_sync_unix = excluded.last_sync_unix",
        params![serial, cursor, captured],
    )?;
    tx.commit()?;
    Ok(inserted)
}

pub(crate) fn timestamp_factor(db: &Connection) -> rusqlite::Result<u64> {
    let version: u32 = db.pragma_query_value(None, "user_version", |row| row.get(0))?;
    match version {
        0 => Ok(100),
        STORE_VERSION => Ok(1),
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}

fn migrate_store(db: &mut Connection) -> rusqlite::Result<()> {
    if timestamp_factor(db)? == 1 {
        return Ok(());
    }
    let tx = db.transaction()?;
    // Stage the old keys in the negative range to avoid collisions while
    // converting from deciseconds. Recheck previously skipped ring records by
    // replaying from zero and deduplicating the retained history.
    tx.execute_batch(
        "UPDATE events SET ring_timestamp = -ring_timestamp;
         UPDATE events SET ring_timestamp = -ring_timestamp * 100;
         UPDATE sync_state SET next_cursor = 0;",
    )?;
    tx.pragma_update(None, "user_version", STORE_VERSION)?;
    tx.commit()
}

fn storage_error(error: rusqlite::Error) -> crate::OuraError {
    operation(format!("Could not checkpoint ring history: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extended_bundles_keep_large_timestamp_deltas_relative() {
        let mut events = Vec::new();
        decode_bundle(
            b"\xaa\x43\x05\x80\x9c\x9c\x39x\xaa\x43\x05\x80\xef\xb9\x34y",
            &mut events,
        )
        .unwrap();
        assert_eq!(
            events
                .iter()
                .map(|event| event.timestamp_ms)
                .collect::<Vec<_>>(),
            [120_000_000, 230_000_000]
        );
    }

    #[test]
    fn converts_old_timestamp_keys_atomically_and_resets_the_old_cursor() {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE events(ring_timestamp INTEGER PRIMARY KEY);
             CREATE TABLE sync_state(next_cursor INTEGER);
             INSERT INTO events VALUES (0), (1), (100);
             INSERT INTO sync_state VALUES (101);",
        )
        .unwrap();

        migrate_store(&mut db).unwrap();
        migrate_store(&mut db).unwrap();
        let mut query = db
            .prepare("SELECT ring_timestamp FROM events ORDER BY ring_timestamp")
            .unwrap();
        let timestamps: Vec<u64> = query
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(timestamps, [0, 100, 10_000]);
        assert_eq!(
            db.query_row("SELECT next_cursor FROM sync_state", [], |row| row
                .get::<_, u64>(0))
                .unwrap(),
            0
        );
    }
}
