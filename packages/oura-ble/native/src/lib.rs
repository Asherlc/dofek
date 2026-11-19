use std::future::Future;
use std::sync::{Arc, Mutex};

use oura_link::{OuraClient, transport::Transport};
use oura_protocol::protocol::feature;
use oura_store::storage::Store;
use rusqlite::{Connection, OpenFlags, params};
use tokio::sync::{broadcast, watch};

uniffi::setup_scaffolding!();

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum OuraError {
    #[error("{message}")]
    Operation { message: String },
    #[error("The ring disconnected. Reconnect to continue.")]
    Disconnected,
}

type Result<T> = std::result::Result<T, OuraError>;

fn operation(message: impl Into<String>) -> OuraError {
    OuraError::Operation {
        message: message.into(),
    }
}

#[derive(uniffi::Record)]
pub struct MeasurementOutcome {
    pub setting: String,
    pub accepted: bool,
    pub reason: Option<String>,
}

#[derive(uniffi::Record)]
pub struct StoredEvent {
    pub tag: u8,
    pub name: String,
    pub ring_timestamp: u32,
    pub captured_unix: i64,
    pub body: Vec<u8>,
    pub decoded_json: Option<String>,
}

#[derive(uniffi::Record)]
pub struct StoredEventPage {
    pub events: Vec<StoredEvent>,
    pub next_row_id: Option<i64>,
}

#[derive(uniffi::Record)]
pub struct SyncReport {
    pub inserted: u32,
    pub warnings: Vec<String>,
}

#[uniffi::export(callback_interface)]
pub trait OuraPacketWriter: Send + Sync {
    fn write(&self, data: Vec<u8>);
}

struct FrameTransport {
    writer: Box<dyn OuraPacketWriter>,
    frames: broadcast::Sender<Vec<u8>>,
}

#[async_trait::async_trait]
impl Transport for FrameTransport {
    async fn write(&self, data: &[u8]) -> oura_link::Result<()> {
        self.writer.write(data.to_vec());
        Ok(())
    }

    fn subscribe(&self) -> broadcast::Receiver<Vec<u8>> {
        self.frames.subscribe()
    }
}

#[derive(uniffi::Object)]
pub struct OuraSession {
    client: OuraClient<FrameTransport>,
    closed: watch::Sender<bool>,
}

#[uniffi::export(async_runtime = "tokio")]
impl OuraSession {
    #[uniffi::constructor]
    pub fn new(writer: Box<dyn OuraPacketWriter>) -> Arc<Self> {
        Arc::new(Self {
            client: OuraClient::new(FrameTransport {
                writer,
                frames: broadcast::channel(4096).0,
            }),
            closed: watch::channel(false).0,
        })
    }

    pub fn push_frame(&self, data: Vec<u8>) {
        // Frames received between requests have no listener.
        let _ = self.client.transport().frames.send(data);
    }

    pub fn close(&self) {
        self.closed.send_replace(true);
    }

    pub async fn identify(&self) -> Result<String> {
        self.connected(identify_serial(&self.client)).await
    }

    pub async fn firmware_version(&self) -> Result<Option<String>> {
        self.connected(async {
            match self.client.firmware().await {
                Ok(info) => Ok(Some(info.firmware_version)),
                Err(oura_link::Error::Protocol(_)) => Ok(None),
                Err(error) => Err(operation(format!(
                    "Could not read the ring firmware: {error}"
                ))),
            }
        })
        .await
    }

    pub async fn pair(&self, serial_number: String, key: Vec<u8>, recovering: bool) -> Result<()> {
        let key = parse_key(key)?;
        self.connected(pair_ring(&self.client, &serial_number, &key, recovering))
            .await
    }

    pub async fn configure_measurements(
        &self,
        settings: Vec<String>,
    ) -> Result<Vec<MeasurementOutcome>> {
        self.connected(async {
            let mut outcomes = Vec::with_capacity(settings.len());
            for setting in settings {
                let outcome = configure_measurement(&self.client, &setting).await;
                outcomes.push(MeasurementOutcome {
                    setting,
                    accepted: outcome.is_ok(),
                    reason: outcome.err(),
                });
            }
            Ok(outcomes)
        })
        .await
    }

    pub async fn verify_pairing(&self, serial_number: String, key: Vec<u8>) -> Result<()> {
        let key = parse_key(key)?;
        self.connected(verify_pairing(&self.client, &serial_number, &key))
            .await
    }

    pub async fn sync_history(
        &self,
        database_path: String,
        serial_number: String,
        key: Vec<u8>,
    ) -> Result<SyncReport> {
        let key = parse_key(key)?;
        self.connected(async {
            verify_pairing(&self.client, &serial_number, &key).await?;
            self.client.setup_app_stream().await.map_err(|error| {
                operation(format!(
                    "Could not start the ring's history stream: {error}"
                ))
            })?;
            if self.client.sync_time_app().await.is_err() {
                self.client
                    .sync_time()
                    .await
                    .map_err(|error| operation(format!("Could not set the ring clock: {error}")))?;
            }
            let mut warnings = Vec::new();
            match self.client.check_sleep_analysis(false).await {
                Ok(_) => {}
                Err(oura_link::Error::Protocol(error)) => {
                    warnings.push(format!(
                        "The ring did not confirm sleep processing: {error}"
                    ));
                }
                Err(error) => {
                    return Err(operation(format!(
                        "Could not request ring sleep processing: {error}"
                    )));
                }
            }
            let inserted = sync_to_store(&self.client, &database_path, &serial_number).await?;
            Ok(SyncReport { inserted, warnings })
        })
        .await
    }
}

impl OuraSession {
    async fn connected<T>(&self, work: impl Future<Output = Result<T>>) -> Result<T> {
        let mut closed = self.closed.subscribe();
        if *closed.borrow_and_update() {
            return Err(OuraError::Disconnected);
        }
        tokio::select! {
            biased;
            _ = closed.changed() => Err(OuraError::Disconnected),
            result = work => result,
        }
    }
}

fn parse_key(key: Vec<u8>) -> Result<[u8; 16]> {
    key.try_into()
        .map_err(|_| operation("The stored ring key must contain 16 bytes."))
}

async fn identify_serial<T: Transport>(client: &OuraClient<T>) -> Result<String> {
    let serial = client
        .serial()
        .await
        .map_err(|error| operation(format!("Could not identify the selected ring: {error}")))?;
    if serial.trim().is_empty() {
        return Err(operation(
            "The connected device returned an empty ring serial.",
        ));
    }
    Ok(serial)
}

async fn verify_ring<T: Transport>(client: &OuraClient<T>, expected: &str) -> Result<()> {
    if identify_serial(client).await? != expected {
        return Err(operation(
            "The connected ring does not match the selected ring.",
        ));
    }
    Ok(())
}

async fn authenticate<T: Transport>(client: &OuraClient<T>, key: &[u8; 16]) -> Result<()> {
    client.authenticate(key).await.map(|_| ()).map_err(|error| match error {
        oura_link::Error::Auth(_) => operation(
            "The ring did not accept its saved pairing. If it was factory-reset, forget it in this app and pair it again.",
        ),
        error => operation(format!("Could not authenticate the ring: {error}")),
    })
}

async fn verify_pairing<T: Transport>(
    client: &OuraClient<T>,
    serial: &str,
    key: &[u8; 16],
) -> Result<()> {
    verify_ring(client, serial).await?;
    authenticate(client, key).await
}

async fn pair_ring<T: Transport>(
    client: &OuraClient<T>,
    serial: &str,
    key: &[u8; 16],
    recovering: bool,
) -> Result<()> {
    verify_ring(client, serial).await?;
    match client.set_auth_key(key).await {
        Ok(()) => authenticate(client, key).await,
        Err(oura_link::Error::Auth(_)) if recovering => authenticate(client, key).await,
        Err(oura_link::Error::Auth(_)) => Err(operation(
            "The ring refused a new key. Pair a new or factory-reset ring.",
        )),
        Err(error) => Err(operation(format!(
            "Could not install the ring key: {error}"
        ))),
    }
}

async fn configure_measurement<T: Transport>(
    client: &OuraClient<T>,
    setting: &str,
) -> std::result::Result<(), String> {
    let capability = match setting {
        "heart_rate" => feature::DAYTIME_HR,
        "spo2" => feature::SPO2,
        _ => return Err("Unsupported measurement setting.".into()),
    };
    client
        .feature_status(capability)
        .await
        .map_err(|_| String::from("The ring did not report support for this measurement."))?;
    client
        .set_feature_mode(capability, 1)
        .await
        .map_err(|_| String::from("The ring did not enable this measurement."))?;
    let status = client
        .feature_status(capability)
        .await
        .map_err(|_| String::from("The ring did not confirm the measurement setting."))?;
    if status.mode != 1 {
        return Err("The ring reported that automatic measurement is still off.".into());
    }
    Ok(())
}

async fn sync_to_store<T: Transport>(
    client: &OuraClient<T>,
    path: &str,
    serial: &str,
) -> Result<u32> {
    let store = Store::open(path)
        .map_err(|error| operation(format!("Could not open the event store: {error}")))?;
    let cursor = store
        .cursor(serial)
        .map_err(|error| operation(format!("Could not read the sync cursor: {error}")))?;
    let store = Mutex::new(store);
    let mut inserted = 0;
    let first = drain_batch_stream(client, &store, serial, cursor, &mut inserted).await;
    let rebase = match first {
        Ok(outcome) if cursor > 0 && outcome.events_synced == 0 => {
            // An empty increment is normal unless the last confirmed ring event
            // disappeared, such as after the ring's event clock restarted.
            let marker = client
                .drain_events(cursor - 1, |_| true, |_| true)
                .await
                .map_err(|error| operation(format!("Could not verify the sync cursor: {error}")))?;
            marker.events_synced == 0 || marker.next_cursor < cursor
        }
        Ok(_) => false,
        Err(DrainError::Link(oura_link::Error::Protocol(ref message)))
            if cursor > 0
                && message.contains("extended history request failed with result code 0xff") =>
        {
            true
        }
        Err(error) => return Err(operation(error.to_string())),
    };
    if rebase {
        store
            .lock()
            .unwrap()
            .set_cursor(serial, 0)
            .map_err(|error| {
                operation(format!("Could not reset the stale sync cursor: {error}"))
            })?;
        drain_batch_stream(client, &store, serial, 0, &mut inserted)
            .await
            .map_err(|error| operation(error.to_string()))?;
    }
    Ok(inserted)
}

#[derive(Debug, thiserror::Error)]
enum DrainError {
    #[error("Could not commit an event batch: {0}")]
    Storage(oura_store::error::Error),
    #[error("Could not finish ring history sync: {0}")]
    Link(oura_link::Error),
}

async fn drain_batch_stream<T: Transport>(
    client: &OuraClient<T>,
    store: &Mutex<Store>,
    serial: &str,
    cursor: u32,
    inserted: &mut u32,
) -> std::result::Result<oura_link::client::SyncOutcome, DrainError> {
    let batch = Mutex::new(Vec::new());
    let mut storage_error = None;
    let drained = client
        .drain_events(
            cursor,
            |event| {
                batch.lock().unwrap().push(event.clone());
                true
            },
            |progress| {
                let mut batch = batch.lock().unwrap();
                match store
                    .lock()
                    .unwrap()
                    .commit_batch(serial, &batch, progress.next_cursor)
                {
                    Ok(count) => {
                        *inserted += count;
                        batch.clear();
                        true
                    }
                    Err(error) => {
                        storage_error = Some(error);
                        false
                    }
                }
            },
        )
        .await;
    if let Some(error) = storage_error {
        return Err(DrainError::Storage(error));
    }
    drained.map_err(DrainError::Link)
}

#[uniffi::export]
pub fn read_event_page(
    database_path: String,
    serial_number: String,
    after_row_id: i64,
    limit: u32,
) -> Result<StoredEventPage> {
    if !(1..=500).contains(&limit) || after_row_id < 0 {
        return Err(operation(
            "Event pages require a limit from 1 to 500 and a valid page token.",
        ));
    }
    let database = Connection::open_with_flags(database_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| operation(format!("Could not open the event store: {error}")))?;
    event_page(&database, &serial_number, after_row_id, limit)
        .map_err(|error| operation(format!("Could not read recorded events: {error}")))
}

fn event_page(
    database: &Connection,
    serial: &str,
    after_row_id: i64,
    limit: u32,
) -> rusqlite::Result<StoredEventPage> {
    let mut query = database.prepare(
        "SELECT id, tag, name, ring_timestamp, captured_unix, body, decoded_json
         FROM events WHERE serial = ?1 AND id > ?2 ORDER BY id LIMIT ?3",
    )?;
    let mut rows = query.query(params![serial, after_row_id, i64::from(limit) + 1])?;
    let mut events = Vec::new();
    let mut last_row_id = None;
    while let Some(row) = rows.next()? {
        if events.len() == limit as usize {
            return Ok(StoredEventPage {
                events,
                next_row_id: last_row_id,
            });
        }
        last_row_id = Some(row.get(0)?);
        events.push(StoredEvent {
            tag: row.get(1)?,
            name: row.get(2)?,
            ring_timestamp: row.get(3)?,
            captured_unix: row.get(4)?,
            body: row.get(5)?,
            decoded_json: row.get(6)?,
        });
    }
    Ok(StoredEventPage {
        events,
        next_row_id: None,
    })
}

#[cfg(test)]
mod tests;
