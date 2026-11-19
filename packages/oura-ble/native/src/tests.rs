use std::{sync::Mutex, time::Duration};

use oura_link::{OuraClient, transport::Transport};
use oura_store::storage::Store;
use rusqlite::Connection;
use tokio::sync::{broadcast, oneshot};

use crate::{
    OuraError, OuraPacketWriter, OuraSession, configure_measurement, event_page, pair_ring,
    sync_to_store, verify_pairing,
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

    impl OuraPacketWriter for Writer {
        fn write(&self, _data: Vec<u8>) {
            self.0.lock().unwrap().take().unwrap().send(()).unwrap();
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
async fn resumes_from_the_batch_committed_before_disconnect() {
    let path = std::env::temp_dir().join(format!("oura-resume-{}.sqlite", std::process::id()));
    let database = path.to_str().unwrap();
    let flush = (b"\x28\x01\x00".as_slice(), Some(b"\x29\x01\x00".as_slice()));
    let first = Replay::client(&[
        flush,
        (b"\x2f\x0c\x41\x00\x00\x00", Some(b"\x2f\x09\x43\x06\x00\xaa\x43\x03\x64\xbb\xcc\x2f\x0a\x42\x01\x00\x00\x00\x00\x00\x00\x00\x00")),
        (b"\x28\x01\x00", None),
    ]);
    assert!(sync_to_store(&first, database, TEST_SERIAL).await.is_err());
    let cursor = Store::open(&path).unwrap().cursor(TEST_SERIAL).unwrap();
    assert_eq!(cursor, 2);

    let second = Replay::client(&[
        flush,
        (b"\x2f\x0c\x41\x00\xc8\x00", Some(b"\x2f\x0a\x43\x07\x00\xaa\x43\x04\xc8\x01\xbb\xcc\x2f\x0a\x42\x01\x00\x00\x00\x00\x00\x00\x00\x00")),
        flush,
        (b"\x2f\x0c\x41\x00\x2c\x01", Some(b"\x2f\x0a\x42\x00\x00\x00\x00\x00\x00\x00\x00\x00")),
    ]);
    let inserted = sync_to_store(&second, database, TEST_SERIAL).await.unwrap();
    assert_eq!(inserted, 1);
    assert_eq!(Store::open(&path).unwrap().cursor(TEST_SERIAL).unwrap(), 3);
    std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn remembers_the_rebased_cursor_when_a_ring_rejects_a_stale_checkpoint() {
    let path = std::env::temp_dir().join(format!("oura-rebase-{}.sqlite", std::process::id()));
    Store::open(&path)
        .unwrap()
        .set_cursor(TEST_SERIAL, 2)
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
        sync_to_store(&client, path.to_str().unwrap(), TEST_SERIAL)
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
    assert_eq!(first.events[0].ring_timestamp, 24);
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
