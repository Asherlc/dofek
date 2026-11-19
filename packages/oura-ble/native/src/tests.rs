use std::{sync::Mutex, time::Duration};

use oura_link::{OuraClient, transport::Transport};
use oura_store::storage::Store;
use rusqlite::Connection;
use tokio::sync::{broadcast, oneshot};

use crate::history::sync_to_store;
use crate::{
    OuraError, OuraPacketWriter, OuraSession, configure_measurement, event_page, pair_ring,
    verify_pairing,
};

const TEST_SERIAL: &str = "XXXXXXXXXXXX";
const TEST_KEY: [u8; 16] = [0; 16];

struct Replay {
    steps: Mutex<std::collections::VecDeque<(&'static [u8], Option<&'static [u8]>)>>,
    frames: broadcast::Sender<Vec<u8>>,
}

impl Replay {
    fn client(steps: &[(&'static [u8], Option<&'static [u8]>)]) -> OuraClient<Self> {
        OuraClient::new(Self {
            steps: Mutex::new(steps.iter().copied().collect()),
            frames: broadcast::channel(8).0,
        })
        .with_quiet(Duration::from_millis(5))
    }
}

#[async_trait::async_trait]
impl Transport for Replay {
    async fn write(&self, request: &[u8]) -> oura_link::Result<()> {
        let (prefix, response) = self
            .steps
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected request");
        assert!(request.starts_with(prefix), "unexpected request tag");
        if let Some(response) = response {
            self.frames.send(response.to_vec()).unwrap();
            Ok(())
        } else {
            Err(oura_link::Error::Ble("simulated disconnect".into()))
        }
    }

    fn subscribe(&self) -> broadcast::Receiver<Vec<u8>> {
        self.frames.subscribe()
    }
}

const SERIAL: (&[u8], Option<&[u8]>) = (b"\x18\x03\x08\x00\x10", Some(b"\x19\x11\x00XXXXXXXXXXXX"));
const NONCE: (&[u8], Option<&[u8]>) = (
    b"\x2f\x01\x2b",
    Some(b"\x2f\x10\x2c\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0a\x0b\x0c\x0d\x0e"),
);
const AUTHENTICATE: (&[u8], Option<&[u8]>) = (b"\x2f\x11\x2d", Some(b"\x2f\x02\x2e\x00"));

#[tokio::test]
async fn pairs_with_a_new_ring_and_recovers_an_installed_pending_key() {
    for (status, recovering) in [(b"\x25\x01\x00", false), (b"\x25\x01\x01", true)] {
        let client = Replay::client(&[SERIAL, (b"\x24", Some(status)), NONCE, AUTHENTICATE]);
        pair_ring(&client, TEST_SERIAL, &TEST_KEY, recovering)
            .await
            .unwrap();
        assert!(client.transport().steps.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn refuses_to_write_a_key_to_a_different_ring() {
    let client = Replay::client(&[SERIAL]);
    let error = pair_ring(&client, "different-ring", &TEST_KEY, false)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("does not match"));
}

#[tokio::test]
async fn verifies_an_existing_pairing_without_installing_a_key() {
    let client = Replay::client(&[SERIAL, NONCE, AUTHENTICATE]);
    verify_pairing(&client, TEST_SERIAL, &TEST_KEY)
        .await
        .unwrap();
    assert!(client.transport().steps.lock().unwrap().is_empty());
}

#[tokio::test]
async fn distinguishes_a_confirmed_factory_reset_from_an_authentication_error() {
    let reset = Replay::client(&[SERIAL, NONCE, (b"\x2f\x11\x2d", Some(b"\x2f\x02\x2e\x02"))]);
    assert!(matches!(
        verify_pairing(&reset, TEST_SERIAL, &TEST_KEY).await,
        Err(OuraError::PairingReset)
    ));
    let rejected = Replay::client(&[SERIAL, NONCE, (b"\x2f\x11\x2d", Some(b"\x2f\x02\x2e\x01"))]);
    assert!(matches!(
        verify_pairing(&rejected, TEST_SERIAL, &TEST_KEY).await,
        Err(OuraError::Operation { .. })
    ));
}

#[tokio::test]
async fn reports_an_unsupported_setting_without_writing_to_the_ring() {
    let client = Replay::client(&[]);
    assert_eq!(
        configure_measurement(&client, "unknown").await,
        Err("Unsupported measurement setting.".into())
    );
}

#[tokio::test]
async fn disconnect_interrupts_a_pending_response() {
    struct Writer(Mutex<Option<oneshot::Sender<()>>>);

    #[async_trait::async_trait]
    impl OuraPacketWriter for Writer {
        async fn write(&self, _data: Vec<u8>) -> bool {
            self.0.lock().unwrap().take().unwrap().send(()).unwrap();
            true
        }
    }

    let (sent, written) = oneshot::channel();
    let session = OuraSession::new(Box::new(Writer(Mutex::new(Some(sent)))));
    let pending = tokio::spawn({
        let session = session.clone();
        async move { session.identify().await }
    });
    written.await.unwrap();
    session.close();
    assert!(matches!(
        pending.await.unwrap(),
        Err(OuraError::Disconnected)
    ));
}

#[tokio::test]
async fn disconnect_interrupts_a_write_waiting_for_acknowledgment() {
    struct Writer(Mutex<Option<oneshot::Sender<()>>>);

    #[async_trait::async_trait]
    impl OuraPacketWriter for Writer {
        async fn write(&self, _data: Vec<u8>) -> bool {
            self.0.lock().unwrap().take().unwrap().send(()).unwrap();
            std::future::pending().await
        }
    }

    let (sent, writing) = oneshot::channel();
    let session = OuraSession::new(Box::new(Writer(Mutex::new(Some(sent)))));
    let pending = tokio::spawn({
        let session = session.clone();
        async move { session.identify().await }
    });
    writing.await.unwrap();
    session.close();
    assert!(matches!(
        pending.await.unwrap(),
        Err(OuraError::Disconnected)
    ));
}

#[tokio::test]
async fn resumes_from_the_batch_committed_before_disconnect() {
    let path = std::env::temp_dir().join(format!("oura-resume-{}.sqlite", std::process::id()));
    let database = path.to_str().unwrap();
    let flush = (b"\x28\x01\x00".as_slice(), Some(b"\x29\x01\x00".as_slice()));
    let first = Replay::client(&[
        flush,
        (b"\x2f\x0c\x41\x00\x00\x00", Some(b"\x2f\x09\x43\x06\x00\xaa\x43\x03\x64\xbb\xcc\x2f\x0a\x42\x01\x00\x00\x00\x00\x00\x00\x00\x00")),
        (b"\x28\x01\x00", None),
    ]);
    assert!(
        sync_to_store(first.transport(), database, TEST_SERIAL)
            .await
            .is_err()
    );
    let cursor = Store::open(&path).unwrap().cursor(TEST_SERIAL).unwrap();
    assert_eq!(cursor, 100);

    let second = Replay::client(&[
        flush,
        (b"\x2f\x0c\x41\x00\x64\x00", Some(b"\x2f\x0a\x43\x07\x00\xaa\x43\x04\xc8\x01\xbb\xcc\x2f\x0a\x42\x01\x00\x00\x00\x00\x00\x00\x00\x00")),
        flush,
        (b"\x2f\x0c\x41\x00\xc8\x00", Some(b"\x2f\x0a\x42\x00\x00\x00\x00\x00\x00\x00\x00\x00")),
    ]);
    let inserted = sync_to_store(second.transport(), database, TEST_SERIAL)
        .await
        .unwrap();
    assert_eq!(inserted, 1);
    assert_eq!(
        Store::open(&path).unwrap().cursor(TEST_SERIAL).unwrap(),
        200
    );
    std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn checkpoints_exact_milliseconds_across_extended_batches() {
    let path = std::env::temp_dir().join(format!("oura-exact-{}.sqlite", std::process::id()));
    let flush = (b"\x28\x01\x00".as_slice(), Some(b"\x29\x01\x00".as_slice()));
    let client = Replay::client(&[
        flush,
        // Absolute timestamp 1000 ms, then a delta of 1 ms.
        (b"\x2f\x0c\x41\x00\x00\x00", Some(b"\x2f\x0e\x43\x0b\x00\xaa\x43\x03\xe8\x07x\xaa\x43\x02\x01y\x2f\x0a\x42\x02\x00\x00\x01\x00\x00\x00\x00\x00")),
        flush,
        // The inclusive cursor repeats one record at 1001 ms and uncovers
        // another at the same time, followed by one at 1002 ms.
        (b"\x2f\x0c\x41\x00\xe9\x03", Some(b"\x2f\x13\x43\x10\x00\xaa\x43\x03\xe9\x07y\xaa\x43\x02\x00w\xaa\x43\x02\x01z\x2f\x0a\x42\x03\x00\x00\x00\x00\x00\x00\x00\x00")),
        flush,
        (b"\x2f\x0c\x41\x00\xea\x03", Some(b"\x2f\x0a\x42\x00\x00\x00\x00\x00\x00\x00\x00\x00")),
    ]);
    assert_eq!(
        sync_to_store(client.transport(), path.to_str().unwrap(), TEST_SERIAL)
            .await
            .unwrap(),
        4
    );
    let database = Connection::open(&path).unwrap();
    let page = event_page(&database, TEST_SERIAL, 0, 10).unwrap();
    assert_eq!(
        page.events
            .iter()
            .map(|event| event.ring_timestamp)
            .collect::<Vec<_>>(),
        [1000, 1001, 1001, 1002]
    );
    drop(database);
    std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn falls_back_to_legacy_history_without_rounding_the_stored_cursor() {
    let path = std::env::temp_dir().join(format!("oura-legacy-{}.sqlite", std::process::id()));
    let flush = (b"\x28\x01\x00".as_slice(), Some(b"\x29\x01\x00".as_slice()));
    let client = Replay::client(&[
        flush,
        (b"\x2f\x0c\x41\x00", Some(b"\x2f\x02\x00\x41")),
        // Horizon 3.4.3 replies use a zero count even with a payload.
        (b"\x10\x09\x00\x00\x00\x00", Some(b"\x43\x08\x01\x00\x00\x00test\x11\x06\x00\x00\x00\x00\x00\x00")),
        flush,
        (b"\x10\x09\x01\x00\x00\x00", Some(b"\x43\x08\x01\x00\x00\x00test\x43\x05\x02\x00\x00\x00y\x11\x06\x02\x00\x00\x00\x00\x00")),
        flush,
        (b"\x10\x09\x02\x00\x00\x00", Some(b"\x11\x06\x00\x00\x00\x00\x00\x00")),
    ]);
    assert_eq!(
        sync_to_store(client.transport(), path.to_str().unwrap(), TEST_SERIAL)
            .await
            .unwrap(),
        2
    );
    let database = Connection::open(&path).unwrap();
    let page = event_page(&database, TEST_SERIAL, 0, 10).unwrap();
    assert_eq!(
        page.events
            .iter()
            .map(|event| event.ring_timestamp)
            .collect::<Vec<_>>(),
        [100, 200]
    );
    drop(database);
    std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn does_not_commit_an_incomplete_batch_with_a_terminal_summary() {
    let path = std::env::temp_dir().join(format!("oura-incomplete-{}.sqlite", std::process::id()));
    let client = Replay::client(&[
        (b"\x28\x01\x00", Some(b"\x29\x01\x00")),
        // The summary reports two records, but only one came through.
        (b"\x2f\x0c\x41\x00", Some(b"\x2f\x09\x43\x06\x00\xaa\x43\x03\x64\xbb\xcc\x2f\x0a\x42\x02\x00\x00\x00\x00\x00\x00\x00\x00")),
        (b"\x28\x01\x00", None),
    ]);
    let error = sync_to_store(client.transport(), path.to_str().unwrap(), TEST_SERIAL)
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("reported 2 events but received 1")
    );
    assert_eq!(Store::open(&path).unwrap().cursor(TEST_SERIAL).unwrap(), 0);
    let db = Connection::open(&path).unwrap();
    assert!(
        event_page(&db, TEST_SERIAL, 0, 10)
            .unwrap()
            .events
            .is_empty()
    );
    drop(db);
    std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn remembers_the_rebased_cursor_when_a_ring_rejects_a_stale_checkpoint() {
    let path = std::env::temp_dir().join(format!("oura-rebase-{}.sqlite", std::process::id()));
    Store::open(&path)
        .unwrap()
        .set_cursor(TEST_SERIAL, 200)
        .unwrap();
    Connection::open(&path)
        .unwrap()
        .pragma_update(None, "user_version", 1)
        .unwrap();
    let client = Replay::client(&[
        (b"\x28\x01\x00", Some(b"\x29\x01\x00")),
        (
            b"\x2f\x0c\x41\x00\xc8\x00",
            Some(b"\x2f\x0a\x42\x00\x00\x00\x00\x00\x00\x00\x00\xff"),
        ),
        (b"\x28\x01\x00", None),
    ]);
    assert!(
        sync_to_store(client.transport(), path.to_str().unwrap(), TEST_SERIAL)
            .await
            .is_err()
    );
    assert!(client.transport().steps.lock().unwrap().is_empty());
    assert_eq!(Store::open(&path).unwrap().cursor(TEST_SERIAL).unwrap(), 0);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn pages_unknown_events_with_the_original_tag_and_body() {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(
        "CREATE TABLE events (
            id INTEGER PRIMARY KEY, serial TEXT, tag INTEGER, name TEXT,
            ring_timestamp INTEGER, captured_unix INTEGER, body BLOB, decoded_json TEXT
        );
        INSERT INTO events VALUES (1, 'test-ring', 250, 'unknown', 24, 1000, X'010203', NULL);
        INSERT INTO events VALUES (2, 'other-ring', 250, 'unknown', 25, 1000, X'04', NULL);
        INSERT INTO events VALUES (3, 'test-ring', 251, 'unknown', 26, 1001, X'05', NULL);",
    )
    .unwrap();

    let first = event_page(&db, "test-ring", 0, 1).unwrap();
    assert_eq!(first.next_row_id, Some(1));
    assert_eq!(first.events[0].tag, 250);
    assert_eq!(first.events[0].body, [1, 2, 3]);
    assert_eq!(first.events[0].ring_timestamp, 2400);
    assert_eq!(first.events[0].captured_unix, 1000);
    assert!(first.events[0].decoded_json.is_none());

    let second = event_page(&db, "test-ring", 1, 1).unwrap();
    assert_eq!(
        second
            .events
            .iter()
            .map(|event| event.tag)
            .collect::<Vec<_>>(),
        [251]
    );
    assert_eq!(second.next_row_id, None);
}
