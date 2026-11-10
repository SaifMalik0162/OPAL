use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

use image::ImageFormat;
use lofty::{
    file::{AudioFile, TaggedFileExt},
    probe::Probe,
    tag::Accessor,
};
use rusqlite::{backup::Backup, params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use symphonia::core::{
    audio::SampleBuffer, codecs::DecoderOptions, errors::Error as AudioDecodeError,
    formats::FormatOptions, io::MediaSourceStream, meta::MetadataOptions, probe::Hint,
};
use symphonia::default::{get_codecs, get_probe};
use tauri::{Emitter, Manager};
use tauri_plugin_log::RotationStrategy;
use uuid::Uuid;

#[cfg(debug_assertions)]
mod dev_fixtures;
#[cfg(debug_assertions)]
pub use dev_fixtures::generate_fixture_libraries;

const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
const DATABASE_VERSION: i64 = 7;
const BUILD_COMMIT: &str = match option_env!("OPAL_BUILD_COMMIT") {
    Some(commit) => commit,
    None => "unknown",
};
const MAX_DIAGNOSTIC_ERRORS: usize = 12;
static DIAGNOSTIC_ERRORS: OnceLock<Mutex<VecDeque<String>>> = OnceLock::new();

#[cfg(target_os = "macos")]
use tauri::TitleBarStyle;

#[cfg(target_os = "macos")]
use window_vibrancy::{
    apply_liquid_glass, apply_vibrancy, LiquidGlassOptions, NSGlassEffectViewStyle,
    NSVisualEffectMaterial, NSVisualEffectState,
};

#[cfg(target_os = "windows")]
use window_vibrancy::{apply_acrylic, apply_blur, apply_mica};

#[derive(Clone)]
struct StorageRoots {
    root: PathBuf,
    db_path: PathBuf,
    audio_dir: PathBuf,
    artwork_dir: PathBuf,
    staging_dir: PathBuf,
}

#[derive(Default)]
struct StartupState {
    storage_error: Mutex<Option<String>>,
}

#[derive(Default)]
struct ImportState {
    active_projects: Mutex<HashSet<String>>,
    latest: Mutex<HashMap<String, ImportProgress>>,
}

struct ImportGuard<'a> {
    state: &'a ImportState,
    project_id: String,
}

impl<'a> Drop for ImportGuard<'a> {
    fn drop(&mut self) {
        if let Ok(mut active) = self.state.active_projects.lock() {
            active.remove(&self.project_id);
        }
    }
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TrackDto {
    id: String,
    project_id: String,
    group_id: String,
    title: String,
    source_title: String,
    position: i64,
    version_name: String,
    version_position: i64,
    is_current: bool,
    version_count: usize,
    duration_ms: i64,
    duration: String,
    format: String,
    managed_file_ref: String,
    managed_file_path: Option<String>,
    note: Option<NoteDto>,
    moments: Vec<MomentDto>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NoteDto {
    id: String,
    project_id: Option<String>,
    track_id: Option<String>,
    text: String,
    updated_at: i64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MomentDto {
    id: String,
    track_id: String,
    lineage_id: String,
    time_ms: i64,
    state: String,
    text: String,
    is_resolved: bool,
    parent_id: Option<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TransitionDto {
    id: String,
    project_id: String,
    from_group_id: String,
    to_group_id: String,
    gap_ms: i64,
    note: String,
    updated_at: i64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CapsuleResponseDto {
    id: String,
    capsule_id: String,
    track_id: String,
    moment_id: String,
    time_ms: i64,
    state: String,
    text: String,
    created_at: i64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CapsuleDto {
    id: String,
    project_id: String,
    project_title: String,
    project_description: String,
    title: String,
    message: String,
    artwork_path: Option<String>,
    include_notes: bool,
    has_password: bool,
    expires_at: Option<i64>,
    created_at: i64,
    updated_at: i64,
    share_reference: String,
    is_expired: bool,
    tracks: Vec<TrackDto>,
    project_note: Option<NoteDto>,
    transitions: Vec<TransitionDto>,
    responses: Vec<CapsuleResponseDto>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CapsuleSummaryDto {
    id: String,
    project_id: String,
    title: String,
    message: String,
    include_notes: bool,
    has_password: bool,
    expires_at: Option<i64>,
    created_at: i64,
    updated_at: i64,
    track_count: usize,
    missing_version_count: usize,
    is_expired: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProjectDto {
    id: String,
    title: String,
    description: String,
    artwork_ref: Option<String>,
    artwork_path: Option<String>,
    created_at: i64,
    updated_at: i64,
    year: i64,
    updated: String,
    type_label: String,
    count: usize,
    duration_ms: i64,
    duration: String,
    tracks: Vec<TrackDto>,
    project_note: Option<NoteDto>,
    transitions: Vec<TransitionDto>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ImportProgress {
    project_id: String,
    current: usize,
    total: usize,
    file_name: String,
    status: String,
    message: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ImportStatus {
    progress: Option<ImportProgress>,
    active: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StorageInfo {
    folder_path: String,
    database_path: String,
    total_bytes: u64,
    database_bytes: u64,
    audio_bytes: u64,
    artwork_bytes: u64,
    project_count: usize,
    track_count: usize,
    backup_count: usize,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Diagnostics {
    app_version: String,
    build_commit: String,
    platform: String,
    architecture: String,
    database_version: Option<i64>,
    schema_version: i64,
    database_status: String,
    integrity: String,
    project_count: usize,
    track_count: usize,
    pending_cleanup_count: usize,
    active_import_count: usize,
    recent_errors: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct BackupManifest {
    format_version: u32,
    app_version: String,
    exported_at: i64,
    database: String,
    audio_directory: String,
    artwork_directory: String,
    project_count: usize,
    track_count: usize,
    #[serde(default)]
    assets: Vec<BackupAsset>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct BackupAsset {
    path: String,
    size_bytes: u64,
    sha256: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestoreJournal {
    id: String,
    #[serde(default)]
    original_items: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RestoreFailurePoint {
    DuringStagingCopy,
    AfterPreRestoreBackup,
    AfterDatabaseMoved,
    AfterAudioInstalled,
    BeforeCommitMarker,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BackupFailurePoint {
    BeforeAudioCopy,
    AfterAudioCopy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ImportFailurePoint {
    DuringStagingCopy,
    AfterGroupCreated,
    AfterTrackInserted,
}

#[derive(Debug, Serialize, Clone, Copy, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct DeletionImpact {
    affected_capsules: usize,
    affected_responses: usize,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ImportItemResult {
    path: String,
    file_name: String,
    status: String,
    message: String,
    track: Option<TrackDto>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ImportSummary {
    results: Vec<ImportItemResult>,
    duplicate_paths: Vec<String>,
    imported_count: usize,
}

struct AudioMetadata {
    title: String,
    duration_ms: i64,
    warning: Option<String>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

fn record_diagnostic_error(context: &'static str) {
    let errors = DIAGNOSTIC_ERRORS.get_or_init(|| Mutex::new(VecDeque::new()));
    if let Ok(mut errors) = errors.lock() {
        errors.push_back(format!("{} · {context}", now_ms()));
        while errors.len() > MAX_DIAGNOSTIC_ERRORS {
            errors.pop_front();
        }
    }
}

fn recent_diagnostic_errors() -> Vec<String> {
    DIAGNOSTIC_ERRORS
        .get_or_init(|| Mutex::new(VecDeque::new()))
        .lock()
        .map(|errors| errors.iter().cloned().collect())
        .unwrap_or_default()
}

fn storage_roots(app: &tauri::AppHandle) -> Result<StorageRoots, String> {
    let mut root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not locate OPAL app storage: {error}"))?;
    #[cfg(debug_assertions)]
    if let Some(override_path) = std::env::var_os("OPAL_DEV_DATA_DIR") {
        let fixture_root = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("Could not locate OPAL Development storage: {error}"))?
            .join("opal-fixtures")
            .canonicalize()
            .map_err(|error| format!("Could not locate generated OPAL fixtures: {error}"))?;
        let override_path = PathBuf::from(override_path)
            .canonicalize()
            .map_err(|error| format!("Could not locate the selected OPAL fixture: {error}"))?;
        if !override_path.starts_with(&fixture_root) {
            return Err(
                "OPAL development storage must stay inside the isolated Development fixture folder."
                    .to_string(),
            );
        }
        root = override_path;
    }
    Ok(StorageRoots {
        db_path: root.join("opal.sqlite"),
        audio_dir: root.join("audio"),
        artwork_dir: root.join("artwork"),
        staging_dir: root.join(".staging"),
        root,
    })
}

fn open_database(path: &Path) -> Result<Connection, String> {
    let connection =
        Connection::open(path).map_err(|error| format!("Could not open OPAL database: {error}"))?;
    connection
        .execute_batch("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")
        .map_err(|error| format!("Could not enable database safeguards: {error}"))?;
    Ok(connection)
}

fn lock_library_operation() -> Result<MutexGuard<'static, ()>, String> {
    static LIBRARY_OPERATION_LOCK: Mutex<()> = Mutex::new(());
    LIBRARY_OPERATION_LOCK
        .lock()
        .map_err(|_| "OPAL could not safely serialize this library operation.".to_string())
}

fn database_integrity(connection: &Connection) -> Result<(), String> {
    let result: String = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|error| {
            format!("RECOVERY_REQUIRED: Could not check the OPAL database: {error}")
        })?;
    if result != "ok" {
        return Err(format!(
            "RECOVERY_REQUIRED: OPAL database integrity check failed: {result}"
        ));
    }
    Ok(())
}

fn backup_database_before_migration(
    connection: &Connection,
    path: &Path,
    source_version: i64,
) -> Result<Option<PathBuf>, String> {
    if !path.is_file() {
        return Ok(None);
    }
    let backup_dir = path
        .parent()
        .ok_or_else(|| "Could not locate OPAL backup folder.".to_string())?
        .join("backups");
    fs::create_dir_all(&backup_dir)
        .map_err(|error| format!("Could not create OPAL migration backup folder: {error}"))?;
    let backup_path = backup_dir.join(format!(
        "opal-pre-migration-{}-{}.sqlite",
        now_ms(),
        Uuid::new_v4()
    ));
    let result = (|| {
        let mut destination = Connection::open(&backup_path)
            .map_err(|error| format!("Could not create a recoverable migration backup: {error}"))?;
        Backup::new(connection, &mut destination)
            .and_then(|backup| {
                backup.run_to_completion(128, std::time::Duration::from_millis(10), None)
            })
            .map_err(|error| format!("Could not create a recoverable migration backup: {error}"))?;
        database_integrity(&destination)
            .map_err(|error| format!("Migration backup verification failed: {error}"))?;
        let backup_version: i64 = destination
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|error| format!("Could not verify migration backup: {error}"))?;
        if backup_version != source_version {
            return Err(
                "Migration backup verification failed: database version did not match.".to_string(),
            );
        }
        if storage_counts(connection)? != storage_counts(&destination)? {
            return Err(
                "Migration backup verification failed: library counts did not match.".to_string(),
            );
        }
        Ok(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&backup_path);
        return Err(error);
    }
    Ok(Some(backup_path))
}

fn migrate_moments_schema(connection: &mut Connection) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Could not begin moments migration: {error}"))?;
    transaction
        .execute_batch(
            "
          CREATE TABLE moments (
            id TEXT PRIMARY KEY NOT NULL,
            track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
            lineage_id TEXT NOT NULL,
            time_ms INTEGER NOT NULL DEFAULT 0,
            state TEXT NOT NULL DEFAULT 'question' CHECK (state IN ('keep', 'change', 'question', 'idea')),
            text TEXT NOT NULL DEFAULT '',
            is_resolved INTEGER NOT NULL DEFAULT 0,
            parent_id TEXT REFERENCES moments(id) ON DELETE SET NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE INDEX moments_track_time ON moments(track_id, time_ms);
          CREATE INDEX moments_lineage ON moments(lineage_id);
          PRAGMA user_version = 5;
        ",
        )
        .map_err(|error| format!("Could not migrate OPAL moments: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Could not commit OPAL moments migration: {error}"))?;
    Ok(())
}

fn migrate_sequence_schema(connection: &mut Connection) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Could not begin sequence migration: {error}"))?;
    transaction
        .execute_batch(
            "
          CREATE TABLE sequence_transitions (
            id TEXT PRIMARY KEY NOT NULL,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            from_group_id TEXT NOT NULL REFERENCES track_groups(id) ON DELETE CASCADE,
            to_group_id TEXT NOT NULL REFERENCES track_groups(id) ON DELETE CASCADE,
            gap_ms INTEGER NOT NULL DEFAULT 0 CHECK (gap_ms >= 0 AND gap_ms <= 600000),
            note TEXT NOT NULL DEFAULT '',
            updated_at INTEGER NOT NULL,
            UNIQUE(project_id, from_group_id, to_group_id),
            CHECK (from_group_id <> to_group_id)
          );
          CREATE INDEX sequence_transitions_project ON sequence_transitions(project_id);
          PRAGMA user_version = 6;
        ",
        )
        .map_err(|error| format!("Could not migrate OPAL sequence transitions: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Could not commit OPAL sequence migration: {error}"))?;
    Ok(())
}

fn migrate_capsules_schema(connection: &mut Connection) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Could not begin capsule migration: {error}"))?;
    transaction
        .execute_batch(
            "
          CREATE TABLE listening_capsules (
            id TEXT PRIMARY KEY NOT NULL,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            message TEXT NOT NULL DEFAULT '',
            include_notes INTEGER NOT NULL DEFAULT 0,
            password_hash TEXT,
            expires_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE INDEX listening_capsules_project ON listening_capsules(project_id, updated_at);
          CREATE TABLE capsule_tracks (
            capsule_id TEXT NOT NULL REFERENCES listening_capsules(id) ON DELETE CASCADE,
            track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
            position INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY(capsule_id, track_id),
            UNIQUE(capsule_id, position)
          );
          CREATE INDEX capsule_tracks_position ON capsule_tracks(capsule_id, position);
          CREATE TABLE capsule_responses (
            id TEXT PRIMARY KEY NOT NULL,
            capsule_id TEXT NOT NULL REFERENCES listening_capsules(id) ON DELETE CASCADE,
            track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
            moment_id TEXT NOT NULL REFERENCES moments(id) ON DELETE CASCADE,
            time_ms INTEGER NOT NULL DEFAULT 0,
            state TEXT NOT NULL CHECK (state IN ('keep', 'change', 'question', 'idea')),
            text TEXT NOT NULL,
            created_at INTEGER NOT NULL
          );
          CREATE INDEX capsule_responses_capsule ON capsule_responses(capsule_id, created_at);
          PRAGMA user_version = 7;
        ",
        )
        .map_err(|error| format!("Could not migrate OPAL capsules: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Could not commit OPAL capsule migration: {error}"))?;
    Ok(())
}

fn initialise_database(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create database folder: {error}"))?;
    }
    let mut connection = open_database(path)?;
    if path.is_file() {
        database_integrity(&connection)?;
    }
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| format!("Could not read database version: {error}"))?;
    if version > DATABASE_VERSION {
        return Err(format!(
            "COMPATIBILITY_REQUIRED: This library was created by a newer OPAL version (database {version}). Install a newer OPAL build to open it. Your library has not been changed."
        ));
    }
    if version > 0 && version < DATABASE_VERSION {
        backup_database_before_migration(&connection, path, version)?;
    }
    if version == 0 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("Could not begin database migration: {error}"))?;
        transaction
            .execute_batch(
                "
          CREATE TABLE projects (
            id TEXT PRIMARY KEY NOT NULL,
            title TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            artwork_ref TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE TABLE track_groups (
            id TEXT PRIMARY KEY NOT NULL,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            position INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(project_id, position)
          );
          CREATE INDEX track_groups_project_position ON track_groups(project_id, position);
          CREATE TABLE tracks (
            id TEXT PRIMARY KEY NOT NULL,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            group_id TEXT REFERENCES track_groups(id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            position INTEGER NOT NULL,
            version_name TEXT NOT NULL DEFAULT 'Original',
            version_position INTEGER NOT NULL DEFAULT 0,
            is_current INTEGER NOT NULL DEFAULT 1,
            duration_ms INTEGER NOT NULL DEFAULT 0,
            format TEXT NOT NULL,
            managed_file_ref TEXT NOT NULL,
            source_hash TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(project_id, position)
          );
          CREATE INDEX tracks_project_position ON tracks(project_id, position);
          CREATE INDEX tracks_group_version ON tracks(group_id, version_position);
          CREATE INDEX tracks_project_hash ON tracks(project_id, source_hash);
          CREATE TABLE notes (
            id TEXT PRIMARY KEY NOT NULL,
            project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
            track_id TEXT REFERENCES tracks(id) ON DELETE CASCADE,
            text TEXT NOT NULL DEFAULT '',
            updated_at INTEGER NOT NULL,
            CHECK ((project_id IS NOT NULL AND track_id IS NULL) OR (project_id IS NULL AND track_id IS NOT NULL)),
            UNIQUE(project_id),
            UNIQUE(track_id)
          );
          CREATE INDEX notes_project ON notes(project_id);
          CREATE INDEX notes_track ON notes(track_id);
          CREATE TABLE cleanup_queue (
            id TEXT PRIMARY KEY NOT NULL,
            managed_path TEXT NOT NULL UNIQUE,
            queued_at INTEGER NOT NULL
          );
          CREATE INDEX cleanup_queue_path ON cleanup_queue(managed_path);
          CREATE TABLE moments (
            id TEXT PRIMARY KEY NOT NULL,
            track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
            lineage_id TEXT NOT NULL,
            time_ms INTEGER NOT NULL DEFAULT 0,
            state TEXT NOT NULL DEFAULT 'question' CHECK (state IN ('keep', 'change', 'question', 'idea')),
            text TEXT NOT NULL DEFAULT '',
            is_resolved INTEGER NOT NULL DEFAULT 0,
            parent_id TEXT REFERENCES moments(id) ON DELETE SET NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE INDEX moments_track_time ON moments(track_id, time_ms);
          CREATE INDEX moments_lineage ON moments(lineage_id);
          CREATE TABLE sequence_transitions (
            id TEXT PRIMARY KEY NOT NULL,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            from_group_id TEXT NOT NULL REFERENCES track_groups(id) ON DELETE CASCADE,
            to_group_id TEXT NOT NULL REFERENCES track_groups(id) ON DELETE CASCADE,
            gap_ms INTEGER NOT NULL DEFAULT 0 CHECK (gap_ms >= 0 AND gap_ms <= 600000),
            note TEXT NOT NULL DEFAULT '',
            updated_at INTEGER NOT NULL,
            UNIQUE(project_id, from_group_id, to_group_id),
            CHECK (from_group_id <> to_group_id)
          );
          CREATE INDEX sequence_transitions_project ON sequence_transitions(project_id);
          CREATE TABLE listening_capsules (
            id TEXT PRIMARY KEY NOT NULL,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            message TEXT NOT NULL DEFAULT '',
            include_notes INTEGER NOT NULL DEFAULT 0,
            password_hash TEXT,
            expires_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE INDEX listening_capsules_project ON listening_capsules(project_id, updated_at);
          CREATE TABLE capsule_tracks (
            capsule_id TEXT NOT NULL REFERENCES listening_capsules(id) ON DELETE CASCADE,
            track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
            position INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY(capsule_id, track_id),
            UNIQUE(capsule_id, position)
          );
          CREATE INDEX capsule_tracks_position ON capsule_tracks(capsule_id, position);
          CREATE TABLE capsule_responses (
            id TEXT PRIMARY KEY NOT NULL,
            capsule_id TEXT NOT NULL REFERENCES listening_capsules(id) ON DELETE CASCADE,
            track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
            moment_id TEXT NOT NULL REFERENCES moments(id) ON DELETE CASCADE,
            time_ms INTEGER NOT NULL DEFAULT 0,
            state TEXT NOT NULL CHECK (state IN ('keep', 'change', 'question', 'idea')),
            text TEXT NOT NULL,
            created_at INTEGER NOT NULL
          );
          CREATE INDEX capsule_responses_capsule ON capsule_responses(capsule_id, created_at);
          PRAGMA user_version = 7;
        ",
            )
            .map_err(|error| format!("Could not migrate OPAL database: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("Could not commit OPAL database migration: {error}"))?;
    } else if version == 1 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("Could not begin database migration: {error}"))?;
        transaction
            .execute_batch(
                "
          CREATE TABLE notes (
            id TEXT PRIMARY KEY NOT NULL,
            project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
            track_id TEXT REFERENCES tracks(id) ON DELETE CASCADE,
            text TEXT NOT NULL DEFAULT '',
            updated_at INTEGER NOT NULL,
            CHECK ((project_id IS NOT NULL AND track_id IS NULL) OR (project_id IS NULL AND track_id IS NOT NULL)),
            UNIQUE(project_id),
            UNIQUE(track_id)
          );
          CREATE INDEX notes_project ON notes(project_id);
          CREATE INDEX notes_track ON notes(track_id);
          CREATE TABLE cleanup_queue (
            id TEXT PRIMARY KEY NOT NULL,
            managed_path TEXT NOT NULL UNIQUE,
            queued_at INTEGER NOT NULL
          );
          CREATE INDEX cleanup_queue_path ON cleanup_queue(managed_path);
          CREATE TABLE track_groups (
            id TEXT PRIMARY KEY NOT NULL,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            position INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(project_id, position)
          );
          CREATE INDEX track_groups_project_position ON track_groups(project_id, position);
          ALTER TABLE tracks ADD COLUMN group_id TEXT REFERENCES track_groups(id) ON DELETE CASCADE;
          ALTER TABLE tracks ADD COLUMN version_name TEXT NOT NULL DEFAULT 'Original';
          ALTER TABLE tracks ADD COLUMN version_position INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE tracks ADD COLUMN is_current INTEGER NOT NULL DEFAULT 1;
          CREATE INDEX tracks_group_version ON tracks(group_id, version_position);
          INSERT INTO track_groups (id, project_id, title, position, created_at)
            SELECT id, project_id, title, position, created_at FROM tracks;
          UPDATE tracks SET group_id = id, version_name = 'Original', version_position = 0, is_current = 1;
          PRAGMA user_version = 4;
        ",
            )
            .map_err(|error| format!("Could not migrate OPAL database: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("Could not commit OPAL database migration: {error}"))?;
    } else if version == 2 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("Could not begin database migration: {error}"))?;
        transaction
            .execute_batch(
                "
          CREATE TABLE cleanup_queue (
            id TEXT PRIMARY KEY NOT NULL,
            managed_path TEXT NOT NULL UNIQUE,
            queued_at INTEGER NOT NULL
          );
          CREATE INDEX cleanup_queue_path ON cleanup_queue(managed_path);
          CREATE TABLE track_groups (
            id TEXT PRIMARY KEY NOT NULL,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            position INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(project_id, position)
          );
          CREATE INDEX track_groups_project_position ON track_groups(project_id, position);
          ALTER TABLE tracks ADD COLUMN group_id TEXT REFERENCES track_groups(id) ON DELETE CASCADE;
          ALTER TABLE tracks ADD COLUMN version_name TEXT NOT NULL DEFAULT 'Original';
          ALTER TABLE tracks ADD COLUMN version_position INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE tracks ADD COLUMN is_current INTEGER NOT NULL DEFAULT 1;
          CREATE INDEX tracks_group_version ON tracks(group_id, version_position);
          INSERT INTO track_groups (id, project_id, title, position, created_at)
            SELECT id, project_id, title, position, created_at FROM tracks;
          UPDATE tracks SET group_id = id, version_name = 'Original', version_position = 0, is_current = 1;
          PRAGMA user_version = 4;
        ",
            )
            .map_err(|error| format!("Could not migrate OPAL database: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("Could not commit OPAL database migration: {error}"))?;
    } else if version == 3 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("Could not begin database migration: {error}"))?;
        transaction
            .execute_batch(
                "
          CREATE TABLE track_groups (
            id TEXT PRIMARY KEY NOT NULL,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            position INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(project_id, position)
          );
          CREATE INDEX track_groups_project_position ON track_groups(project_id, position);
          ALTER TABLE tracks ADD COLUMN group_id TEXT REFERENCES track_groups(id) ON DELETE CASCADE;
          ALTER TABLE tracks ADD COLUMN version_name TEXT NOT NULL DEFAULT 'Original';
          ALTER TABLE tracks ADD COLUMN version_position INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE tracks ADD COLUMN is_current INTEGER NOT NULL DEFAULT 1;
          CREATE INDEX tracks_group_version ON tracks(group_id, version_position);
          INSERT INTO track_groups (id, project_id, title, position, created_at)
            SELECT id, project_id, title, position, created_at FROM tracks;
          UPDATE tracks SET group_id = id, version_name = 'Original', version_position = 0, is_current = 1;
          PRAGMA user_version = 4;
        ",
            )
            .map_err(|error| format!("Could not migrate OPAL database: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("Could not commit OPAL database migration: {error}"))?;
    }
    let current_version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| format!("Could not read migrated database version: {error}"))?;
    if current_version == 4 {
        migrate_moments_schema(&mut connection)?;
    }
    let current_version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| format!("Could not read moments database version: {error}"))?;
    if current_version == 5 {
        migrate_sequence_schema(&mut connection)?;
    }
    let current_version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| format!("Could not read sequence database version: {error}"))?;
    if current_version == 6 {
        migrate_capsules_schema(&mut connection)?;
    } else if current_version > DATABASE_VERSION {
        return Err(format!(
            "COMPATIBILITY_REQUIRED: This library was created by a newer OPAL version (database {current_version}). Install a newer OPAL build to open it. Your library has not been changed."
        ));
    }
    database_integrity(&connection)?;
    Ok(())
}

fn recover_abandoned_staging(roots: &StorageRoots) -> Result<(), String> {
    if !roots.staging_dir.exists() {
        fs::create_dir_all(&roots.staging_dir)
            .map_err(|error| format!("Could not create import staging: {error}"))?;
        return Ok(());
    }
    for entry in fs::read_dir(&roots.staging_dir)
        .map_err(|error| format!("Could not inspect interrupted imports: {error}"))?
    {
        let path = entry
            .map_err(|error| format!("Could not inspect interrupted import entry: {error}"))?
            .path();
        if path.is_dir() {
            fs::remove_dir_all(&path).map_err(|error| {
                format!("Could not recover interrupted import staging: {error}")
            })?;
        } else if path.exists() {
            fs::remove_file(&path)
                .map_err(|error| format!("Could not recover interrupted import file: {error}"))?;
        }
    }
    Ok(())
}

fn initialise_storage(roots: &StorageRoots) -> Result<(), String> {
    fs::create_dir_all(&roots.root)
        .map_err(|error| format!("Could not create OPAL storage: {error}"))?;
    fs::create_dir_all(&roots.audio_dir)
        .map_err(|error| format!("Could not create audio storage: {error}"))?;
    fs::create_dir_all(&roots.artwork_dir)
        .map_err(|error| format!("Could not create artwork storage: {error}"))?;
    recover_interrupted_restore(roots)?;
    initialise_database(&roots.db_path)?;
    // This runs only after the database has passed integrity and migrations, so an interrupted
    // batch can be discarded without touching managed files already committed to audio/.
    recover_abandoned_staging(roots)?;
    retry_pending_cleanup(roots)?;
    Ok(())
}

fn prepare_storage(app: &tauri::AppHandle) -> Result<StorageRoots, String> {
    if let Some(state) = app.try_state::<StartupState>() {
        if let Some(error) = state
            .storage_error
            .lock()
            .map_err(|_| "OPAL startup state is unavailable.".to_string())?
            .clone()
        {
            return Err(error);
        }
    }
    let roots = storage_roots(app)?;
    fs::create_dir_all(&roots.root)
        .map_err(|error| format!("Could not create OPAL storage: {error}"))?;
    fs::create_dir_all(&roots.audio_dir)
        .map_err(|error| format!("Could not create audio storage: {error}"))?;
    fs::create_dir_all(&roots.artwork_dir)
        .map_err(|error| format!("Could not create artwork storage: {error}"))?;
    fs::create_dir_all(&roots.staging_dir)
        .map_err(|error| format!("Could not create import staging: {error}"))?;
    Ok(roots)
}

fn format_track_duration(duration_ms: i64) -> String {
    if duration_ms <= 0 {
        return "—".to_string();
    }
    let total_seconds = duration_ms / 1000;
    format!("{}:{:02}", total_seconds / 60, total_seconds % 60)
}

fn format_project_duration(duration_ms: i64) -> String {
    if duration_ms <= 0 {
        return "—".to_string();
    }
    let total_minutes = duration_ms / 60_000;
    if total_minutes < 1 {
        "Less than a minute".to_string()
    } else if total_minutes >= 60 {
        format!("{} hr {} min", total_minutes / 60, total_minutes % 60)
    } else {
        format!("{} min", total_minutes)
    }
}

fn project_type(count: usize) -> String {
    match count {
        0 => "New project".to_string(),
        1..=6 => "EP".to_string(),
        _ => "LP".to_string(),
    }
}

fn year_label(timestamp_ms: i64) -> i64 {
    1970 + timestamp_ms / 31_556_952_000
}

fn updated_label(timestamp_ms: i64) -> String {
    let days = ((now_ms() - timestamp_ms).max(0) / 86_400_000) as u64;
    match days {
        0 => "Updated today".to_string(),
        1 => "Updated yesterday".to_string(),
        value => format!("Updated {value} days ago"),
    }
}

fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_lowercase()
}

fn supported_audio(path: &Path) -> bool {
    matches!(
        extension(path).as_str(),
        "wav" | "mp3" | "flac" | "aiff" | "aif" | "m4a"
    )
}

fn supported_artwork(path: &Path) -> bool {
    matches!(extension(path).as_str(), "png" | "jpg" | "jpeg" | "webp")
}

fn display_file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Unnamed file")
        .to_string()
}

fn fallback_title(path: &Path) -> String {
    path.file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Untitled track")
        .to_string()
}

fn hash_file(path: &Path) -> Result<String, String> {
    let mut file =
        File::open(path).map_err(|error| format!("Could not read source file: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("Could not read source file: {error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn extract_audio_metadata(path: &Path) -> Result<AudioMetadata, String> {
    let metadata =
        fs::metadata(path).map_err(|error| format!("Could not inspect audio file: {error}"))?;
    if metadata.len() == 0 {
        return Err("This audio file is empty.".to_string());
    }
    let fallback = fallback_title(path);
    let tagged_file = Probe::open(path)
        .and_then(|probe| probe.read())
        .map_err(|_| {
            "OPAL couldn’t read this audio file. It may be corrupt or incomplete.".to_string()
        })?;
    let duration = tagged_file.properties().duration();
    if duration.is_zero() {
        return Err("OPAL couldn’t find any playable audio frames in this file.".to_string());
    }
    let title = tagged_file
        .primary_tag()
        .or_else(|| tagged_file.first_tag())
        .and_then(|tag| tag.title())
        .map(|title| title.into_owned())
        .filter(|title| !title.trim().is_empty())
        .unwrap_or(fallback);
    Ok(AudioMetadata {
        title,
        duration_ms: (duration.as_millis() as i64).max(1),
        warning: None,
    })
}

fn decode_audio_waveform(path: &Path, length: usize) -> Result<Vec<u8>, String> {
    let source = File::open(path).map_err(|error| format!("Could not open audio file: {error}"))?;
    let extension = extension(path);
    let mut hint = Hint::new();
    hint.with_extension(&extension);
    let source = MediaSourceStream::new(Box::new(source), Default::default());
    let mut reader = get_probe()
        .format(
            &hint,
            source,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|error| format!("OPAL couldn’t decode this {extension} audio file: {error}"))?;
    let track = reader
        .format
        .default_track()
        .ok_or_else(|| "OPAL couldn’t find an audio track in this file.".to_string())?;
    let track_id = track.id;
    let codec_params = track.codec_params.clone();
    let sample_rate = codec_params
        .sample_rate
        .filter(|sample_rate| *sample_rate > 0)
        .ok_or_else(|| "OPAL couldn’t read the sample rate for this audio file.".to_string())?;
    let mut decoder = get_codecs()
        .make(&codec_params, &DecoderOptions::default())
        .map_err(|error| format!("This {extension} codec isn’t available in OPAL: {error}"))?;
    let mut peak_buckets = Vec::<f32>::new();
    let mut frames_decoded = 0_u64;
    let bucket_frames = u64::from((sample_rate / 20).max(1));

    loop {
        let packet = match reader.format.next_packet() {
            Ok(packet) => packet,
            Err(AudioDecodeError::IoError(error))
                if error.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(error) => {
                return Err(format!(
                    "OPAL couldn’t read this {extension} audio file: {error}"
                ));
            }
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = decoder.decode(&packet).map_err(|error| match error {
            AudioDecodeError::DecodeError(message) => {
                format!("OPAL couldn’t decode this {extension} audio file: {message}")
            }
            other => format!("OPAL couldn’t decode this {extension} audio file: {other}"),
        })?;
        let channel_count = decoded.spec().channels.count();
        if channel_count == 0 {
            return Err("OPAL couldn’t read the channel layout for this audio file.".to_string());
        }
        let mut samples = SampleBuffer::<f32>::new(decoded.capacity() as u64, *decoded.spec());
        samples.copy_interleaved_ref(decoded);
        let interleaved = samples.samples();
        for (frame_offset, frame) in interleaved.chunks(channel_count).enumerate() {
            let peak = frame
                .iter()
                .map(|sample| sample.abs())
                .fold(0.0_f32, f32::max);
            let bucket = ((frames_decoded + frame_offset as u64) / bucket_frames) as usize;
            if peak_buckets.len() <= bucket {
                peak_buckets.resize(bucket + 1, 0.0);
            }
            peak_buckets[bucket] = peak_buckets[bucket].max(peak);
        }
        frames_decoded += (interleaved.len() / channel_count) as u64;
    }

    if frames_decoded == 0 || peak_buckets.is_empty() {
        return Err("OPAL couldn’t find any decodable audio frames in this file.".to_string());
    }
    let count = length.max(1);
    let mut bars = Vec::with_capacity(count);
    for index in 0..count {
        let start = index * peak_buckets.len() / count;
        let end = ((index + 1) * peak_buckets.len() / count).max(start + 1);
        let peak = peak_buckets[start.min(peak_buckets.len() - 1)..end.min(peak_buckets.len())]
            .iter()
            .copied()
            .fold(0.0_f32, f32::max);
        bars.push((18.0 + (peak.sqrt() * 78.0)).round().clamp(18.0, 96.0) as u8);
    }
    Ok(bars)
}

fn track_from_row(row: &rusqlite::Row<'_>, roots: &StorageRoots) -> rusqlite::Result<TrackDto> {
    let duration_ms: i64 = row.get(10)?;
    let managed_file_ref: String = row.get(12)?;
    let managed_file_path = roots.root.join(&managed_file_ref);
    Ok(TrackDto {
        id: row.get(0)?,
        project_id: row.get(1)?,
        title: row.get(3)?,
        group_id: row.get(2)?,
        source_title: row.get(4)?,
        position: row.get(5)?,
        version_name: row.get(6)?,
        version_position: row.get(7)?,
        is_current: row.get::<_, i64>(8)? != 0,
        version_count: row.get::<_, i64>(9)? as usize,
        duration_ms,
        duration: format_track_duration(duration_ms),
        format: row.get(11)?,
        managed_file_ref,
        managed_file_path: managed_file_path
            .is_file()
            .then(|| managed_file_path.to_string_lossy().into_owned()),
        note: None,
        moments: Vec::new(),
    })
}

fn note_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<NoteDto> {
    Ok(NoteDto {
        id: row.get(0)?,
        project_id: row.get(1)?,
        track_id: row.get(2)?,
        text: row.get(3)?,
        updated_at: row.get(4)?,
    })
}

fn load_project_note(connection: &Connection, project_id: &str) -> Result<Option<NoteDto>, String> {
    connection
        .query_row(
            "SELECT id, project_id, track_id, text, updated_at FROM notes WHERE project_id = ?1",
            params![project_id],
            note_from_row,
        )
        .optional()
        .map_err(|error| format!("Could not load project note: {error}"))
}

fn load_track_note(connection: &Connection, track_id: &str) -> Result<Option<NoteDto>, String> {
    connection
        .query_row(
            "SELECT id, project_id, track_id, text, updated_at FROM notes WHERE track_id = ?1",
            params![track_id],
            note_from_row,
        )
        .optional()
        .map_err(|error| format!("Could not load track note: {error}"))
}

fn moment_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MomentDto> {
    Ok(MomentDto {
        id: row.get(0)?,
        track_id: row.get(1)?,
        lineage_id: row.get(2)?,
        time_ms: row.get(3)?,
        state: row.get(4)?,
        text: row.get(5)?,
        is_resolved: row.get::<_, i64>(6)? != 0,
        parent_id: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

fn load_track_moments(connection: &Connection, track_id: &str) -> Result<Vec<MomentDto>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, track_id, lineage_id, time_ms, state, text, is_resolved, parent_id, created_at, updated_at
             FROM moments WHERE track_id = ?1 ORDER BY time_ms ASC, created_at ASC",
        )
        .map_err(|error| format!("Could not load track moments: {error}"))?;
    let moments = statement
        .query_map(params![track_id], moment_from_row)
        .map_err(|error| format!("Could not read track moments: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not decode track moments: {error}"))?;
    Ok(moments)
}

fn transition_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TransitionDto> {
    Ok(TransitionDto {
        id: row.get(0)?,
        project_id: row.get(1)?,
        from_group_id: row.get(2)?,
        to_group_id: row.get(3)?,
        gap_ms: row.get(4)?,
        note: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn load_project_transitions(
    connection: &Connection,
    project_id: &str,
) -> Result<Vec<TransitionDto>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, project_id, from_group_id, to_group_id, gap_ms, note, updated_at
             FROM sequence_transitions WHERE project_id = ?1 ORDER BY updated_at ASC",
        )
        .map_err(|error| format!("Could not load sequence transitions: {error}"))?;
    let transitions = statement
        .query_map(params![project_id], transition_from_row)
        .map_err(|error| format!("Could not read sequence transitions: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not decode sequence transitions: {error}"))?;
    Ok(transitions)
}

fn load_project(
    connection: &Connection,
    roots: &StorageRoots,
    project_id: &str,
) -> Result<ProjectDto, String> {
    let project = connection
    .query_row(
      "SELECT id, title, description, artwork_ref, created_at, updated_at FROM projects WHERE id = ?1",
      params![project_id],
      |row| {
        Ok((
          row.get::<_, String>(0)?,
          row.get::<_, String>(1)?,
          row.get::<_, String>(2)?,
          row.get::<_, Option<String>>(3)?,
          row.get::<_, i64>(4)?,
          row.get::<_, i64>(5)?,
        ))
      },
    )
    .optional()
    .map_err(|error| format!("Could not load project: {error}"))?
    .ok_or_else(|| "Project no longer exists.".to_string())?;

    let mut statement = connection
        .prepare(
            "SELECT
                t.id,
                t.project_id,
                COALESCE(t.group_id, t.id) AS group_id,
                COALESCE(g.title, t.title) AS group_title,
                t.title AS source_title,
                COALESCE(g.position, t.position) AS group_position,
                COALESCE(t.version_name, 'Original') AS version_name,
                COALESCE(t.version_position, 0) AS version_position,
                COALESCE(t.is_current, 1) AS is_current,
                (
                    SELECT COUNT(*)
                    FROM tracks sibling
                    WHERE COALESCE(sibling.group_id, sibling.id) = COALESCE(t.group_id, t.id)
                ) AS version_count,
                t.duration_ms,
                t.format,
                t.managed_file_ref
             FROM tracks t
             LEFT JOIN track_groups g ON g.id = t.group_id
             WHERE t.project_id = ?1
             ORDER BY COALESCE(g.position, t.position) ASC,
                      COALESCE(t.version_position, 0) ASC,
                      t.position ASC",
        )
        .map_err(|error| format!("Could not load project tracks: {error}"))?;
    let tracks = statement
        .query_map(params![project_id], |row| track_from_row(row, roots))
        .map_err(|error| format!("Could not read project tracks: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not decode project tracks: {error}"))?;
    let mut tracks = tracks;
    for track in &mut tracks {
        track.note = load_track_note(connection, &track.id)?;
        track.moments = load_track_moments(connection, &track.id)?;
    }
    let project_note = load_project_note(connection, project_id)?;
    let transitions = load_project_transitions(connection, project_id)?;
    let group_count = tracks
        .iter()
        .map(|track| track.group_id.as_str())
        .collect::<HashSet<_>>()
        .len();
    let duration_ms = tracks
        .iter()
        .filter(|track| track.is_current)
        .map(|track| track.duration_ms)
        .sum();
    let artwork_path = project
        .3
        .as_ref()
        .map(|reference| roots.root.join(reference))
        .filter(|path| path.is_file());
    Ok(ProjectDto {
        id: project.0,
        title: project.1,
        description: project.2,
        artwork_ref: project.3,
        artwork_path: artwork_path.map(|path| path.to_string_lossy().into_owned()),
        created_at: project.4,
        updated_at: project.5,
        year: year_label(project.4),
        updated: updated_label(project.5),
        type_label: project_type(group_count),
        count: group_count,
        duration_ms,
        duration: format_project_duration(duration_ms),
        tracks,
        project_note,
        transitions,
    })
}

fn load_projects(roots: &StorageRoots) -> Result<Vec<ProjectDto>, String> {
    let connection = open_database(&roots.db_path)?;
    let mut statement = connection
        .prepare("SELECT id FROM projects ORDER BY updated_at DESC, created_at DESC")
        .map_err(|error| format!("Could not load OPAL projects: {error}"))?;
    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Could not read OPAL projects: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not decode OPAL projects: {error}"))?;
    ids.iter()
        .map(|id| load_project(&connection, roots, id))
        .collect()
}

fn capsule_response_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CapsuleResponseDto> {
    Ok(CapsuleResponseDto {
        id: row.get(0)?,
        capsule_id: row.get(1)?,
        track_id: row.get(2)?,
        moment_id: row.get(3)?,
        time_ms: row.get(4)?,
        state: row.get(5)?,
        text: row.get(6)?,
        created_at: row.get(7)?,
    })
}

fn load_capsule_responses(
    connection: &Connection,
    capsule_id: &str,
) -> Result<Vec<CapsuleResponseDto>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, capsule_id, track_id, moment_id, time_ms, state, text, created_at
             FROM capsule_responses WHERE capsule_id = ?1 ORDER BY created_at ASC",
        )
        .map_err(|error| format!("Could not load capsule responses: {error}"))?;
    let responses = statement
        .query_map(params![capsule_id], capsule_response_from_row)
        .map_err(|error| format!("Could not read capsule responses: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not decode capsule responses: {error}"))?;
    Ok(responses)
}

fn capsule_password_hash(capsule_id: &str, password: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(capsule_id.as_bytes());
    hasher.update([0]);
    hasher.update(password.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn load_capsule_record(
    connection: &Connection,
    capsule_id: &str,
) -> Result<
    (
        String,
        String,
        String,
        bool,
        Option<String>,
        Option<i64>,
        i64,
        i64,
    ),
    String,
> {
    connection
        .query_row(
            "SELECT project_id, title, message, include_notes, password_hash, expires_at, created_at, updated_at
             FROM listening_capsules WHERE id = ?1",
            params![capsule_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get::<_, i64>(3)? != 0,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("Could not load capsule: {error}"))?
        .ok_or_else(|| "This capsule no longer exists.".to_string())
}

fn ensure_capsule_access(
    connection: &Connection,
    capsule_id: &str,
    password: Option<&str>,
) -> Result<
    (
        String,
        String,
        String,
        bool,
        Option<String>,
        Option<i64>,
        i64,
        i64,
    ),
    String,
> {
    let record = load_capsule_record(connection, capsule_id)?;
    if record.5.is_some_and(|expires_at| expires_at <= now_ms()) {
        return Err("This capsule has expired.".to_string());
    }
    if let Some(expected_hash) = record.4.as_deref() {
        let supplied = password.unwrap_or_default();
        if supplied.trim().is_empty()
            || capsule_password_hash(capsule_id, supplied) != expected_hash
        {
            return Err("This capsule needs its password before it can be opened.".to_string());
        }
    }
    Ok(record)
}

fn load_capsule(
    connection: &Connection,
    roots: &StorageRoots,
    capsule_id: &str,
) -> Result<CapsuleDto, String> {
    let record = load_capsule_record(connection, capsule_id)?;
    let project = load_project(connection, roots, &record.0)?;
    let selected_ids = {
        let mut statement = connection
            .prepare(
                "SELECT track_id FROM capsule_tracks WHERE capsule_id = ?1 ORDER BY position ASC",
            )
            .map_err(|error| format!("Could not load capsule sequence: {error}"))?;
        let selected_ids = statement
            .query_map(params![capsule_id], |row| row.get::<_, String>(0))
            .map_err(|error| format!("Could not read capsule sequence: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Could not decode capsule sequence: {error}"))?;
        selected_ids
    };
    let mut track_map = project
        .tracks
        .into_iter()
        .map(|track| (track.id.clone(), track))
        .collect::<HashMap<_, _>>();
    let mut tracks = Vec::with_capacity(selected_ids.len());
    for track_id in selected_ids {
        let mut track = track_map
            .remove(&track_id)
            .ok_or_else(|| "A version in this capsule is no longer available.".to_string())?;
        if !record.3 {
            track.note = None;
            track.moments.clear();
        }
        tracks.push(track);
    }
    let selected_groups = tracks
        .iter()
        .map(|track| track.group_id.clone())
        .collect::<HashSet<_>>();
    let project_note = record.3.then_some(project.project_note).flatten();
    let transitions = if record.3 {
        project
            .transitions
            .into_iter()
            .filter(|transition| {
                selected_groups.contains(&transition.from_group_id)
                    && selected_groups.contains(&transition.to_group_id)
            })
            .collect()
    } else {
        Vec::new()
    };
    Ok(CapsuleDto {
        id: capsule_id.to_string(),
        project_id: record.0,
        project_title: project.title,
        project_description: project.description,
        title: record.1,
        message: record.2,
        artwork_path: project.artwork_path,
        include_notes: record.3,
        has_password: record.4.is_some(),
        expires_at: record.5,
        created_at: record.6,
        updated_at: record.7,
        share_reference: format!("opal://capsule/{capsule_id}"),
        is_expired: record.5.is_some_and(|expires_at| expires_at <= now_ms()),
        tracks,
        project_note,
        transitions,
        responses: load_capsule_responses(connection, capsule_id)?,
    })
}

fn list_capsule_summaries(
    connection: &Connection,
    project_id: &str,
) -> Result<Vec<CapsuleSummaryDto>, String> {
    let mut statement = connection
        .prepare(
            "SELECT c.id, c.project_id, c.title, c.message, c.include_notes, c.password_hash,
                    c.expires_at, c.created_at, c.updated_at, COUNT(ct.track_id),
                    COALESCE(SUM(CASE WHEN ct.track_id IS NOT NULL AND t.id IS NULL THEN 1 ELSE 0 END), 0)
             FROM listening_capsules c
             LEFT JOIN capsule_tracks ct ON ct.capsule_id = c.id
             LEFT JOIN tracks t ON t.id = ct.track_id
             WHERE c.project_id = ?1
             GROUP BY c.id
             ORDER BY c.updated_at DESC, c.created_at DESC",
        )
        .map_err(|error| format!("Could not list local capsules: {error}"))?;
    let summaries = statement
        .query_map(params![project_id], |row| {
            let expires_at: Option<i64> = row.get(6)?;
            Ok(CapsuleSummaryDto {
                id: row.get(0)?,
                project_id: row.get(1)?,
                title: row.get(2)?,
                message: row.get(3)?,
                include_notes: row.get::<_, i64>(4)? != 0,
                has_password: row.get::<_, Option<String>>(5)?.is_some(),
                expires_at,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
                track_count: row.get::<_, i64>(9)?.max(0) as usize,
                missing_version_count: row.get::<_, i64>(10)?.max(0) as usize,
                is_expired: expires_at.is_some_and(|value| value <= now_ms()),
            })
        })
        .map_err(|error| format!("Could not read local capsules: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not decode local capsules: {error}"))?;
    Ok(summaries)
}

fn valid_moment_state(state: &str) -> bool {
    matches!(state, "keep" | "change" | "question" | "idea")
}

fn carry_unresolved_moments(
    connection: &Connection,
    source_track_id: &str,
    target_track_id: &str,
) -> Result<(), String> {
    let mut statement = connection
        .prepare(
            "SELECT id, lineage_id, time_ms, state, text
             FROM moments WHERE track_id = ?1 AND is_resolved = 0
             ORDER BY time_ms ASC, created_at ASC",
        )
        .map_err(|error| format!("Could not prepare moments to carry forward: {error}"))?;
    let moments = statement
        .query_map(params![source_track_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(|error| format!("Could not read moments to carry forward: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not decode moments to carry forward: {error}"))?;
    drop(statement);
    let timestamp = now_ms();
    for (parent_id, lineage_id, time_ms, state, text) in moments {
        connection
            .execute(
                "INSERT INTO moments (id, track_id, lineage_id, time_ms, state, text, is_resolved, parent_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, ?8)",
                params![
                    Uuid::new_v4().to_string(),
                    target_track_id,
                    lineage_id,
                    time_ms,
                    state,
                    text,
                    parent_id,
                    timestamp
                ],
            )
            .map_err(|error| format!("Could not carry a moment into the new version: {error}"))?;
    }
    Ok(())
}

fn copy_import_to_staging(
    source: &Path,
    staged_file: &Path,
    injected_failure: Option<ImportFailurePoint>,
) -> Result<(), String> {
    if injected_failure == Some(ImportFailurePoint::DuringStagingCopy) {
        return Err("Injected import copy failure while staging the source file.".to_string());
    }
    fs::copy(source, staged_file)
        .map(|_| ())
        .map_err(|error| format!("Could not copy into OPAL storage: {error}"))
}

fn maybe_fail_import(
    injected: Option<ImportFailurePoint>,
    phase: ImportFailurePoint,
) -> Result<(), String> {
    if injected == Some(phase) {
        Err(format!("Injected import failure at {phase:?}."))
    } else {
        Ok(())
    }
}

fn commit_imported_track(
    connection: &mut Connection,
    staged_file: &Path,
    managed_path: &Path,
    new_group: Option<(&str, &str, i64)>,
    track: &TrackDto,
    position: i64,
    source_hash: &str,
    source_track_id: Option<&str>,
    injected_failure: Option<ImportFailurePoint>,
) -> Result<(), String> {
    fs::rename(staged_file, managed_path)
        .map_err(|error| format!("Could not commit managed audio: {error}"))?;
    let result = (|| {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("Could not begin imported track transaction: {error}"))?;
        if let Some((group_id, title, group_position)) = new_group {
            transaction
                .execute(
                    "INSERT INTO track_groups (id, project_id, title, position, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![group_id, track.project_id, title, group_position, now_ms()],
                )
                .map_err(|error| format!("Could not create track group: {error}"))?;
        }
        maybe_fail_import(injected_failure, ImportFailurePoint::AfterGroupCreated)?;
        transaction
            .execute(
                "INSERT INTO tracks (id, project_id, group_id, title, position, version_name, version_position, is_current, duration_ms, format, managed_file_ref, source_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                params![
                    track.id,
                    track.project_id,
                    track.group_id,
                    track.source_title,
                    position,
                    track.version_name,
                    track.version_position,
                    track.is_current,
                    track.duration_ms,
                    track.format,
                    track.managed_file_ref,
                    source_hash,
                    now_ms()
                ],
            )
            .map_err(|error| format!("Could not save the imported track: {error}"))?;
        maybe_fail_import(injected_failure, ImportFailurePoint::AfterTrackInserted)?;
        if let Some(source_track_id) = source_track_id {
            carry_unresolved_moments(&transaction, source_track_id, &track.id)?;
        }
        transaction
            .execute(
                "UPDATE projects SET updated_at = ?1 WHERE id = ?2",
                params![now_ms(), track.project_id],
            )
            .map_err(|error| format!("Could not update project timestamp: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("Could not commit imported track: {error}"))?;
        Ok::<(), String>(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(managed_path);
    }
    result
}

#[tauri::command(rename = "createMoment", rename_all = "camelCase")]
fn create_moment(
    app: tauri::AppHandle,
    project_id: String,
    track_id: String,
    time_ms: i64,
    state: String,
    text: Option<String>,
) -> Result<ProjectDto, String> {
    let _operation = lock_library_operation()?;
    let roots = prepare_storage(&app)?;
    let state = state.trim().to_lowercase();
    if !valid_moment_state(&state) {
        return Err("Choose a valid moment decision.".to_string());
    }
    let connection = open_database(&roots.db_path)?;
    let duration_ms: i64 = connection
        .query_row(
            "SELECT duration_ms FROM tracks WHERE id = ?1 AND project_id = ?2",
            params![track_id, project_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Could not verify moment track: {error}"))?
        .ok_or_else(|| "Track version no longer exists in this project.".to_string())?;
    let timestamp = now_ms();
    connection
        .execute(
            "INSERT INTO moments (id, track_id, lineage_id, time_ms, state, text, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![
                Uuid::new_v4().to_string(),
                track_id,
                Uuid::new_v4().to_string(),
                time_ms.max(0).min(duration_ms.max(0)),
                state,
                text.unwrap_or_default(),
                timestamp
            ],
        )
        .map_err(|error| format!("Could not save moment: {error}"))?;
    connection
        .execute(
            "UPDATE projects SET updated_at = ?1 WHERE id = ?2",
            params![timestamp, project_id],
        )
        .map_err(|error| format!("Could not update project timestamp: {error}"))?;
    load_project(&connection, &roots, &project_id)
}

#[tauri::command(rename = "updateMoment", rename_all = "camelCase")]
fn update_moment(
    app: tauri::AppHandle,
    project_id: String,
    moment_id: String,
    time_ms: i64,
    state: String,
    text: String,
    is_resolved: bool,
) -> Result<ProjectDto, String> {
    let _operation = lock_library_operation()?;
    let roots = prepare_storage(&app)?;
    let state = state.trim().to_lowercase();
    if !valid_moment_state(&state) {
        return Err("Choose a valid moment decision.".to_string());
    }
    let connection = open_database(&roots.db_path)?;
    let duration_ms: i64 = connection
        .query_row(
            "SELECT tracks.duration_ms FROM moments JOIN tracks ON tracks.id = moments.track_id
             WHERE moments.id = ?1 AND tracks.project_id = ?2",
            params![moment_id, project_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Could not verify moment: {error}"))?
        .ok_or_else(|| "Moment no longer exists in this project.".to_string())?;
    let timestamp = now_ms();
    let changed = connection
        .execute(
            "UPDATE moments SET time_ms = ?1, state = ?2, text = ?3, is_resolved = ?4, updated_at = ?5
             WHERE id = ?6 AND track_id IN (SELECT id FROM tracks WHERE project_id = ?7)",
            params![
                time_ms.max(0).min(duration_ms.max(0)),
                state,
                text,
                is_resolved,
                timestamp,
                moment_id,
                project_id
            ],
        )
        .map_err(|error| format!("Could not update moment: {error}"))?;
    if changed == 0 {
        return Err("Moment no longer exists in this project.".to_string());
    }
    connection
        .execute(
            "UPDATE projects SET updated_at = ?1 WHERE id = ?2",
            params![timestamp, project_id],
        )
        .map_err(|error| format!("Could not update project timestamp: {error}"))?;
    load_project(&connection, &roots, &project_id)
}

#[tauri::command(rename = "updateTransition", rename_all = "camelCase")]
fn update_transition(
    app: tauri::AppHandle,
    project_id: String,
    from_group_id: String,
    to_group_id: String,
    gap_ms: i64,
    note: String,
) -> Result<ProjectDto, String> {
    let _operation = lock_library_operation()?;
    let roots = prepare_storage(&app)?;
    if from_group_id == to_group_id {
        return Err("A transition needs two different tracks.".to_string());
    }
    let connection = open_database(&roots.db_path)?;
    let group_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM track_groups WHERE project_id = ?1 AND id IN (?2, ?3)",
            params![project_id, from_group_id, to_group_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not verify transition tracks: {error}"))?;
    if group_count != 2 {
        return Err("Those tracks no longer exist in this project.".to_string());
    }
    let timestamp = now_ms();
    connection
        .execute(
            "INSERT INTO sequence_transitions (id, project_id, from_group_id, to_group_id, gap_ms, note, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(project_id, from_group_id, to_group_id)
             DO UPDATE SET gap_ms = excluded.gap_ms, note = excluded.note, updated_at = excluded.updated_at",
            params![
                Uuid::new_v4().to_string(),
                project_id,
                from_group_id,
                to_group_id,
                gap_ms.max(0).min(600_000),
                note,
                timestamp
            ],
        )
        .map_err(|error| format!("Could not save sequence transition: {error}"))?;
    connection
        .execute(
            "UPDATE projects SET updated_at = ?1 WHERE id = ?2",
            params![timestamp, project_id],
        )
        .map_err(|error| format!("Could not update project timestamp: {error}"))?;
    load_project(&connection, &roots, &project_id)
}

#[tauri::command(rename = "createCapsule", rename_all = "camelCase")]
fn create_capsule(
    app: tauri::AppHandle,
    project_id: String,
    track_ids: Vec<String>,
    include_notes: bool,
    password: Option<String>,
    expires_at: Option<i64>,
    title: Option<String>,
    message: Option<String>,
) -> Result<CapsuleDto, String> {
    let _operation = lock_library_operation()?;
    let roots = prepare_storage(&app)?;
    if track_ids.is_empty() {
        return Err("Choose at least one version for the capsule.".to_string());
    }
    if expires_at.is_some_and(|value| value <= now_ms()) {
        return Err("Choose an expiry in the future.".to_string());
    }
    let mut connection = open_database(&roots.db_path)?;
    let project_title: String = connection
        .query_row(
            "SELECT title FROM projects WHERE id = ?1",
            params![project_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Could not verify capsule project: {error}"))?
        .ok_or_else(|| "Project no longer exists.".to_string())?;
    let mut seen_groups = HashSet::new();
    for track_id in &track_ids {
        let group_id: String = connection
            .query_row(
                "SELECT COALESCE(group_id, id) FROM tracks WHERE id = ?1 AND project_id = ?2",
                params![track_id, project_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("Could not verify capsule versions: {error}"))?
            .ok_or_else(|| "A selected version no longer exists in this project.".to_string())?;
        if !seen_groups.insert(group_id) {
            return Err("Choose only one version from each track for a capsule.".to_string());
        }
    }
    let capsule_id = Uuid::new_v4().to_string();
    let timestamp = now_ms();
    let title = title.unwrap_or_default().trim().to_string();
    let title = if title.is_empty() {
        project_title
    } else {
        title
    };
    let message = message.unwrap_or_default().trim().to_string();
    let password_hash = password
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| capsule_password_hash(&capsule_id, value));
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Could not begin capsule creation: {error}"))?;
    transaction
        .execute(
            "INSERT INTO listening_capsules (id, project_id, title, message, include_notes, password_hash, expires_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
            params![
                capsule_id,
                project_id,
                title,
                message,
                include_notes,
                password_hash,
                expires_at,
                timestamp
            ],
        )
        .map_err(|error| format!("Could not save capsule: {error}"))?;
    for (position, track_id) in track_ids.iter().enumerate() {
        transaction
            .execute(
                "INSERT INTO capsule_tracks (capsule_id, track_id, position, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![capsule_id, track_id, position as i64, timestamp],
            )
            .map_err(|error| format!("Could not save capsule sequence: {error}"))?;
    }
    transaction
        .commit()
        .map_err(|error| format!("Could not commit capsule: {error}"))?;
    load_capsule(&connection, &roots, &capsule_id)
}

#[tauri::command(rename = "getCapsule", rename_all = "camelCase")]
fn get_capsule(
    app: tauri::AppHandle,
    capsule_id: String,
    password: Option<String>,
) -> Result<CapsuleDto, String> {
    let _operation = lock_library_operation()?;
    let roots = prepare_storage(&app)?;
    let connection = open_database(&roots.db_path)?;
    ensure_capsule_access(&connection, &capsule_id, password.as_deref())?;
    load_capsule(&connection, &roots, &capsule_id)
}

#[tauri::command(rename = "listCapsules", rename_all = "camelCase")]
fn list_capsules(
    app: tauri::AppHandle,
    project_id: String,
) -> Result<Vec<CapsuleSummaryDto>, String> {
    let _operation = lock_library_operation()?;
    let roots = prepare_storage(&app)?;
    let connection = open_database(&roots.db_path)?;
    let project_exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)",
            params![project_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not verify capsule project: {error}"))?;
    if !project_exists {
        return Err("Project no longer exists.".to_string());
    }
    list_capsule_summaries(&connection, &project_id)
}

#[tauri::command(rename = "addCapsuleResponse", rename_all = "camelCase")]
fn add_capsule_response(
    app: tauri::AppHandle,
    capsule_id: String,
    track_id: String,
    time_ms: i64,
    state: String,
    text: String,
    password: Option<String>,
) -> Result<CapsuleDto, String> {
    let _operation = lock_library_operation()?;
    let roots = prepare_storage(&app)?;
    let state = state.trim().to_lowercase();
    if !valid_moment_state(&state) {
        return Err("Choose a valid response state.".to_string());
    }
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("Write a response before sending it back to OPAL.".to_string());
    }
    let mut connection = open_database(&roots.db_path)?;
    ensure_capsule_access(&connection, &capsule_id, password.as_deref())?;
    let duration_ms: i64 = connection
        .query_row(
            "SELECT tracks.duration_ms FROM capsule_tracks
             JOIN tracks ON tracks.id = capsule_tracks.track_id
             WHERE capsule_tracks.capsule_id = ?1 AND capsule_tracks.track_id = ?2",
            params![capsule_id, track_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Could not verify capsule response track: {error}"))?
        .ok_or_else(|| "That version is not part of this capsule.".to_string())?;
    let timestamp = now_ms();
    let moment_id = Uuid::new_v4().to_string();
    let response_id = Uuid::new_v4().to_string();
    let time_ms = time_ms.max(0).min(duration_ms.max(0));
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Could not begin capsule response: {error}"))?;
    transaction
        .execute(
            "INSERT INTO moments (id, track_id, lineage_id, time_ms, state, text, is_resolved, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?7)",
            params![
                moment_id,
                track_id,
                format!("capsule-response:{response_id}"),
                time_ms,
                state,
                text,
                timestamp
            ],
        )
        .map_err(|error| format!("Could not add response moment: {error}"))?;
    transaction
        .execute(
            "INSERT INTO capsule_responses (id, capsule_id, track_id, moment_id, time_ms, state, text, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![response_id, capsule_id, track_id, moment_id, time_ms, state, text, timestamp],
        )
        .map_err(|error| format!("Could not save capsule response: {error}"))?;
    transaction
        .execute(
            "UPDATE listening_capsules SET updated_at = ?1 WHERE id = ?2",
            params![timestamp, capsule_id],
        )
        .map_err(|error| format!("Could not update capsule timestamp: {error}"))?;
    transaction
        .execute(
            "UPDATE projects SET updated_at = ?1 WHERE id = (SELECT project_id FROM listening_capsules WHERE id = ?2)",
            params![timestamp, capsule_id],
        )
        .map_err(|error| format!("Could not update project timestamp: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Could not commit capsule response: {error}"))?;
    load_capsule(&connection, &roots, &capsule_id)
}

fn safe_managed_path(roots: &StorageRoots, managed_path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(managed_path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("That managed path is not inside OPAL storage.".to_string());
    }
    let path = roots.root.join(relative);
    if !path.starts_with(&roots.audio_dir) && !path.starts_with(&roots.artwork_dir) {
        return Err("That managed path is not inside OPAL storage.".to_string());
    }
    Ok(path)
}

fn validate_project_storage_id(project_id: &str) -> Result<(), String> {
    let is_safe = !project_id.is_empty()
        && project_id.len() <= 128
        && project_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'));
    if !is_safe {
        return Err("That project ID cannot be used as a managed storage folder.".to_string());
    }
    Ok(())
}

fn project_storage_dir(root: &Path, project_id: &str) -> Result<PathBuf, String> {
    validate_project_storage_id(project_id)?;
    Ok(root.join(project_id))
}

fn queue_managed_cleanup(connection: &Connection, managed_path: &str) -> Result<(), String> {
    connection
        .execute(
            "INSERT OR IGNORE INTO cleanup_queue (id, managed_path, queued_at) VALUES (?1, ?2, ?3)",
            params![Uuid::new_v4().to_string(), managed_path, now_ms()],
        )
        .map_err(|error| format!("Could not queue managed cleanup: {error}"))?;
    Ok(())
}

fn retry_pending_cleanup(roots: &StorageRoots) -> Result<(), String> {
    let connection = open_database(&roots.db_path)?;
    let mut statement = connection
        .prepare("SELECT managed_path FROM cleanup_queue ORDER BY queued_at ASC")
        .map_err(|error| format!("Could not read pending cleanup: {error}"))?;
    let paths = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Could not decode pending cleanup: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not collect pending cleanup: {error}"))?;
    drop(statement);

    for managed_path in paths {
        let path = match safe_managed_path(roots, &managed_path) {
            Ok(path) => path,
            Err(_) => {
                let _ = connection.execute(
                    "DELETE FROM cleanup_queue WHERE managed_path = ?1",
                    params![managed_path],
                );
                continue;
            }
        };
        let is_artwork = managed_path.starts_with("artwork/");
        let is_directory = path.is_dir();
        let references: i64 = if is_artwork {
            connection
                .query_row(
                    "SELECT COUNT(*) FROM projects WHERE artwork_ref = ?1 OR artwork_ref LIKE ?2",
                    params![managed_path, format!("{managed_path}/%")],
                    |row| row.get(0),
                )
                .map_err(|error| format!("Could not check artwork cleanup references: {error}"))?
        } else if is_directory {
            connection
                .query_row(
                    "SELECT COUNT(*) FROM tracks WHERE managed_file_ref = ?1 OR managed_file_ref LIKE ?2",
                    params![managed_path, format!("{managed_path}/%")],
                    |row| row.get(0),
                )
                .map_err(|error| format!("Could not check audio folder cleanup references: {error}"))?
        } else {
            connection
                .query_row(
                    "SELECT COUNT(*) FROM tracks WHERE managed_file_ref = ?1",
                    params![managed_path],
                    |row| row.get(0),
                )
                .map_err(|error| format!("Could not check audio cleanup references: {error}"))?
        };
        if references > 0 {
            let _ = connection.execute(
                "DELETE FROM cleanup_queue WHERE managed_path = ?1",
                params![managed_path],
            );
            continue;
        }
        let result = if is_artwork || is_directory {
            if path.is_dir() {
                fs::remove_dir_all(&path)
            } else {
                Ok(())
            }
        } else if path.is_file() {
            fs::remove_file(&path)
        } else {
            Ok(())
        };
        if result.is_ok() {
            let _ = connection.execute(
                "DELETE FROM cleanup_queue WHERE managed_path = ?1",
                params![managed_path],
            );
        }
    }
    Ok(())
}

fn remove_managed_file_if_unreferenced(
    connection: &Connection,
    roots: &StorageRoots,
    managed_file_ref: &str,
) -> Result<(), String> {
    let references: i64 = match connection.query_row(
        "SELECT COUNT(*) FROM tracks WHERE managed_file_ref = ?1",
        params![managed_file_ref],
        |row| row.get(0),
    ) {
        Ok(references) => references,
        Err(_) => {
            let _ = queue_managed_cleanup(connection, managed_file_ref);
            return Ok(());
        }
    };
    if references == 0 {
        let managed_path = match safe_managed_path(roots, managed_file_ref) {
            Ok(path) => path,
            Err(_) => return Ok(()),
        };
        if managed_path.is_file() {
            if fs::remove_file(&managed_path).is_err() {
                let _ = queue_managed_cleanup(connection, managed_file_ref);
            }
        }
    }
    Ok(())
}

fn project_artwork_ref(
    connection: &Connection,
    project_id: &str,
) -> Result<Option<Option<String>>, String> {
    connection
        .query_row(
            "SELECT artwork_ref FROM projects WHERE id = ?1",
            params![project_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|error| format!("Could not locate project: {error}"))
}

fn send_import_progress(app: &tauri::AppHandle, progress: ImportProgress) {
    if let Some(state) = app.try_state::<ImportState>() {
        if let Ok(mut latest) = state.latest.lock() {
            latest.insert(progress.project_id.clone(), progress.clone());
        }
    }
    let _ = app.emit("opal://import-progress", progress);
}

impl ImportState {
    fn begin(&self, project_id: &str) -> Result<ImportGuard<'_>, String> {
        let mut active = self
            .active_projects
            .lock()
            .map_err(|_| "OPAL import state is unavailable.".to_string())?;
        if !active.insert(project_id.to_string()) {
            return Err("An import is already running for this project.".to_string());
        }
        Ok(ImportGuard {
            state: self,
            project_id: project_id.to_string(),
        })
    }

    fn status(&self, project_id: &str) -> ImportStatus {
        let active = self
            .active_projects
            .lock()
            .map(|projects| projects.contains(project_id))
            .unwrap_or(false);
        let progress = self
            .latest
            .lock()
            .ok()
            .and_then(|latest| latest.get(project_id).cloned());
        ImportStatus { progress, active }
    }
}

#[tauri::command(rename = "listProjects", rename_all = "camelCase")]
fn list_projects(app: tauri::AppHandle) -> Result<Vec<ProjectDto>, String> {
    let roots = prepare_storage(&app)?;
    load_projects(&roots)
}

#[tauri::command(rename = "createProject", rename_all = "camelCase")]
fn create_project(
    app: tauri::AppHandle,
    title: String,
    description: Option<String>,
) -> Result<ProjectDto, String> {
    let _operation = lock_library_operation()?;
    let roots = prepare_storage(&app)?;
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("Give the project a title before creating it.".to_string());
    }
    let timestamp = now_ms();
    let id = Uuid::new_v4().to_string();
    let connection = open_database(&roots.db_path)?;
    connection
    .execute(
      "INSERT INTO projects (id, title, description, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
      params![id, title, description.unwrap_or_default(), timestamp],
    )
    .map_err(|error| format!("Could not create project: {error}"))?;
    load_project(&connection, &roots, &id)
}

#[tauri::command(rename = "updateProject", rename_all = "camelCase")]
fn update_project(
    app: tauri::AppHandle,
    project_id: String,
    title: String,
    description: String,
) -> Result<ProjectDto, String> {
    let _operation = lock_library_operation()?;
    let roots = prepare_storage(&app)?;
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("A project needs a title.".to_string());
    }
    let connection = open_database(&roots.db_path)?;
    let changed = connection
        .execute(
            "UPDATE projects SET title = ?1, description = ?2, updated_at = ?3 WHERE id = ?4",
            params![title, description, now_ms(), project_id],
        )
        .map_err(|error| format!("Could not update project: {error}"))?;
    if changed == 0 {
        return Err("Project no longer exists.".to_string());
    }
    load_project(&connection, &roots, &project_id)
}

#[tauri::command(rename = "updateTrackTitle", rename_all = "camelCase")]
fn update_track_title(
    app: tauri::AppHandle,
    project_id: String,
    track_id: String,
    title: String,
) -> Result<ProjectDto, String> {
    let _operation = lock_library_operation()?;
    let roots = prepare_storage(&app)?;
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("A track needs a title.".to_string());
    }
    let connection = open_database(&roots.db_path)?;
    let group_id: Option<String> = connection
        .query_row(
            "SELECT COALESCE(group_id, id) FROM tracks WHERE id = ?1 AND project_id = ?2",
            params![track_id, project_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Could not locate track: {error}"))?;
    let group_id = group_id.ok_or_else(|| "Track no longer exists in this project.".to_string())?;
    let changed = connection
        .execute(
            "UPDATE track_groups SET title = ?1 WHERE id = ?2 AND project_id = ?3",
            params![title, group_id, project_id],
        )
        .map_err(|error| format!("Could not rename track: {error}"))?;
    if changed == 0 {
        connection
            .execute(
                "UPDATE tracks SET title = ?1 WHERE id = ?2 AND project_id = ?3",
                params![title, track_id, project_id],
            )
            .map_err(|error| format!("Could not rename track: {error}"))?;
    }
    connection
        .execute(
            "UPDATE projects SET updated_at = ?1 WHERE id = ?2",
            params![now_ms(), project_id],
        )
        .map_err(|error| format!("Could not update project timestamp: {error}"))?;
    load_project(&connection, &roots, &project_id)
}

#[tauri::command(rename = "reorderTracks", rename_all = "camelCase")]
fn reorder_tracks(
    app: tauri::AppHandle,
    project_id: String,
    track_ids: Vec<String>,
) -> Result<ProjectDto, String> {
    let _operation = lock_library_operation()?;
    let roots = prepare_storage(&app)?;
    let mut connection = open_database(&roots.db_path)?;
    let expected_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM tracks WHERE project_id = ?1",
            params![project_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not count project tracks: {error}"))?;
    if expected_count as usize != track_ids.len() {
        return Err(
            "The track order is out of date. Reload the project and try again.".to_string(),
        );
    }
    let unique_ids = track_ids.iter().collect::<HashSet<_>>();
    if unique_ids.len() != track_ids.len() {
        return Err("A track cannot appear twice in the order.".to_string());
    }
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Could not begin track reorder: {error}"))?;
    for track_id in &track_ids {
        let belongs_to_project: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM tracks WHERE id = ?1 AND project_id = ?2)",
                params![track_id, project_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("Could not validate track order: {error}"))?;
        if !belongs_to_project {
            return Err("The track order contains an unknown track.".to_string());
        }
    }
    transaction
        .execute(
            "UPDATE tracks SET position = -(position + 1) WHERE project_id = ?1",
            params![project_id],
        )
        .map_err(|error| format!("Could not stage track order: {error}"))?;
    for (position, track_id) in track_ids.iter().enumerate() {
        transaction
            .execute(
                "UPDATE tracks SET position = ?1 WHERE id = ?2 AND project_id = ?3",
                params![position as i64, track_id, project_id],
            )
            .map_err(|error| format!("Could not save track order: {error}"))?;
    }
    transaction
        .execute(
            "UPDATE projects SET updated_at = ?1 WHERE id = ?2",
            params![now_ms(), project_id],
        )
        .map_err(|error| format!("Could not update project timestamp: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Could not commit track order: {error}"))?;
    load_project(&connection, &roots, &project_id)
}

#[tauri::command(rename = "reorderTrackGroups", rename_all = "camelCase")]
fn reorder_track_groups(
    app: tauri::AppHandle,
    project_id: String,
    group_ids: Vec<String>,
) -> Result<ProjectDto, String> {
    let _operation = lock_library_operation()?;
    let roots = prepare_storage(&app)?;
    let mut connection = open_database(&roots.db_path)?;
    let expected_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM track_groups WHERE project_id = ?1",
            params![project_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not count track groups: {error}"))?;
    if expected_count as usize != group_ids.len() {
        return Err(
            "The track order is out of date. Reload the project and try again.".to_string(),
        );
    }
    let unique_ids = group_ids.iter().collect::<HashSet<_>>();
    if unique_ids.len() != group_ids.len() {
        return Err("A track cannot appear twice in the order.".to_string());
    }
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Could not begin track group reorder: {error}"))?;
    for group_id in &group_ids {
        let belongs_to_project: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM track_groups WHERE id = ?1 AND project_id = ?2)",
                params![group_id, project_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("Could not validate track group order: {error}"))?;
        if !belongs_to_project {
            return Err("The track order contains an unknown group.".to_string());
        }
    }
    transaction
        .execute(
            "UPDATE track_groups SET position = -(position + 1) WHERE project_id = ?1",
            params![project_id],
        )
        .map_err(|error| format!("Could not stage track group order: {error}"))?;
    for (position, group_id) in group_ids.iter().enumerate() {
        transaction
            .execute(
                "UPDATE track_groups SET position = ?1 WHERE id = ?2 AND project_id = ?3",
                params![position as i64, group_id, project_id],
            )
            .map_err(|error| format!("Could not save track group order: {error}"))?;
    }
    transaction
        .execute(
            "UPDATE projects SET updated_at = ?1 WHERE id = ?2",
            params![now_ms(), project_id],
        )
        .map_err(|error| format!("Could not update project timestamp: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Could not commit track group order: {error}"))?;
    load_project(&connection, &roots, &project_id)
}

#[tauri::command(rename = "reorderTrackVersions", rename_all = "camelCase")]
fn reorder_track_versions(
    app: tauri::AppHandle,
    project_id: String,
    track_ids: Vec<String>,
) -> Result<ProjectDto, String> {
    let _operation = lock_library_operation()?;
    let roots = prepare_storage(&app)?;
    let mut connection = open_database(&roots.db_path)?;
    let first_track_id = track_ids
        .first()
        .ok_or_else(|| "A version order needs at least one version.".to_string())?;
    let group_id: String = connection
        .query_row(
            "SELECT COALESCE(group_id, id) FROM tracks WHERE id = ?1 AND project_id = ?2",
            params![first_track_id, project_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Could not locate track version: {error}"))?
        .ok_or_else(|| "Track version no longer exists in this project.".to_string())?;
    let expected_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM tracks WHERE project_id = ?1 AND COALESCE(group_id, id) = ?2",
            params![project_id, group_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not count track versions: {error}"))?;
    if expected_count as usize != track_ids.len() {
        return Err(
            "The version order is out of date. Reload the project and try again.".to_string(),
        );
    }
    let unique_ids = track_ids.iter().collect::<HashSet<_>>();
    if unique_ids.len() != track_ids.len() {
        return Err("A version cannot appear twice in the order.".to_string());
    }
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Could not begin version reorder: {error}"))?;
    for track_id in &track_ids {
        let belongs_to_group: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM tracks WHERE id = ?1 AND project_id = ?2 AND COALESCE(group_id, id) = ?3)",
                params![track_id, project_id, group_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("Could not validate version order: {error}"))?;
        if !belongs_to_group {
            return Err("The version order contains an unknown version.".to_string());
        }
    }
    transaction
        .execute(
            "UPDATE tracks SET version_position = -(version_position + 1) WHERE project_id = ?1 AND COALESCE(group_id, id) = ?2",
            params![project_id, group_id],
        )
        .map_err(|error| format!("Could not stage version order: {error}"))?;
    for (position, track_id) in track_ids.iter().enumerate() {
        transaction
            .execute(
                "UPDATE tracks SET version_position = ?1 WHERE id = ?2 AND project_id = ?3",
                params![position as i64, track_id, project_id],
            )
            .map_err(|error| format!("Could not save version order: {error}"))?;
    }
    transaction
        .execute(
            "UPDATE projects SET updated_at = ?1 WHERE id = ?2",
            params![now_ms(), project_id],
        )
        .map_err(|error| format!("Could not update project timestamp: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Could not commit version order: {error}"))?;
    load_project(&connection, &roots, &project_id)
}

#[tauri::command(rename = "renameTrackVersion", rename_all = "camelCase")]
fn rename_track_version(
    app: tauri::AppHandle,
    project_id: String,
    track_id: String,
    version_name: String,
) -> Result<ProjectDto, String> {
    let _operation = lock_library_operation()?;
    let roots = prepare_storage(&app)?;
    let version_name = version_name.trim().to_string();
    if version_name.is_empty() {
        return Err("A version needs a name.".to_string());
    }
    let connection = open_database(&roots.db_path)?;
    let changed = connection
        .execute(
            "UPDATE tracks SET version_name = ?1 WHERE id = ?2 AND project_id = ?3",
            params![version_name, track_id, project_id],
        )
        .map_err(|error| format!("Could not rename track version: {error}"))?;
    if changed == 0 {
        return Err("Track version no longer exists in this project.".to_string());
    }
    connection
        .execute(
            "UPDATE projects SET updated_at = ?1 WHERE id = ?2",
            params![now_ms(), project_id],
        )
        .map_err(|error| format!("Could not update project timestamp: {error}"))?;
    load_project(&connection, &roots, &project_id)
}

#[tauri::command(rename = "promoteTrackVersion", rename_all = "camelCase")]
fn promote_track_version(
    app: tauri::AppHandle,
    project_id: String,
    track_id: String,
) -> Result<ProjectDto, String> {
    let _operation = lock_library_operation()?;
    let roots = prepare_storage(&app)?;
    let mut connection = open_database(&roots.db_path)?;
    let group_id: String = connection
        .query_row(
            "SELECT COALESCE(group_id, id) FROM tracks WHERE id = ?1 AND project_id = ?2",
            params![track_id, project_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Could not locate track version: {error}"))?
        .ok_or_else(|| "Track version no longer exists in this project.".to_string())?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Could not begin version promotion: {error}"))?;
    transaction
        .execute(
            "UPDATE tracks SET is_current = 0 WHERE project_id = ?1 AND COALESCE(group_id, id) = ?2",
            params![project_id, group_id],
        )
        .map_err(|error| format!("Could not clear current version: {error}"))?;
    transaction
        .execute(
            "UPDATE tracks SET is_current = 1 WHERE id = ?1 AND project_id = ?2",
            params![track_id, project_id],
        )
        .map_err(|error| format!("Could not promote track version: {error}"))?;
    transaction
        .execute(
            "UPDATE projects SET updated_at = ?1 WHERE id = ?2",
            params![now_ms(), project_id],
        )
        .map_err(|error| format!("Could not update project timestamp: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Could not commit version promotion: {error}"))?;
    load_project(&connection, &roots, &project_id)
}

fn capsule_deletion_impact(
    connection: &Connection,
    project_id: &str,
    track_id: Option<&str>,
) -> Result<DeletionImpact, String> {
    let (capsules, responses): (i64, i64) = if let Some(track_id) = track_id {
        let capsules = connection
            .query_row(
                "SELECT COUNT(*) FROM listening_capsules c
                 WHERE c.project_id = ?1 AND (
                   EXISTS (SELECT 1 FROM capsule_tracks ct WHERE ct.capsule_id = c.id AND ct.track_id = ?2)
                   OR EXISTS (SELECT 1 FROM capsule_responses cr WHERE cr.capsule_id = c.id AND cr.track_id = ?2)
                 )",
                params![project_id, track_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("Could not count affected Capsules: {error}"))?;
        let responses = connection
            .query_row(
                "SELECT COUNT(*) FROM capsule_responses cr
                 JOIN listening_capsules c ON c.id = cr.capsule_id
                 WHERE c.project_id = ?1 AND c.id IN (
                   SELECT capsule_id FROM capsule_tracks WHERE track_id = ?2
                   UNION SELECT capsule_id FROM capsule_responses WHERE track_id = ?2
                 )",
                params![project_id, track_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("Could not count affected Capsule responses: {error}"))?;
        (capsules, responses)
    } else {
        let capsules = connection
            .query_row(
                "SELECT COUNT(*) FROM listening_capsules WHERE project_id = ?1",
                params![project_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("Could not count affected Capsules: {error}"))?;
        let responses = connection
            .query_row(
                "SELECT COUNT(*) FROM capsule_responses cr
                 JOIN listening_capsules c ON c.id = cr.capsule_id WHERE c.project_id = ?1",
                params![project_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("Could not count affected Capsule responses: {error}"))?;
        (capsules, responses)
    };
    Ok(DeletionImpact {
        affected_capsules: capsules as usize,
        affected_responses: responses as usize,
    })
}

fn delete_capsules_referencing_track(
    connection: &Connection,
    track_id: &str,
) -> Result<(), String> {
    connection
        .execute(
            "DELETE FROM listening_capsules WHERE id IN (
               SELECT capsule_id FROM capsule_tracks WHERE track_id = ?1
               UNION SELECT capsule_id FROM capsule_responses WHERE track_id = ?1
             )",
            params![track_id],
        )
        .map_err(|error| format!("Could not remove Capsules linked to this version: {error}"))?;
    Ok(())
}

#[tauri::command(rename = "getDeletionImpact", rename_all = "camelCase")]
fn get_deletion_impact(
    app: tauri::AppHandle,
    project_id: String,
    track_id: Option<String>,
) -> Result<DeletionImpact, String> {
    let _operation = lock_library_operation()?;
    let roots = prepare_storage(&app)?;
    let connection = open_database(&roots.db_path)?;
    if let Some(track_id) = track_id.as_deref() {
        let belongs_to_project: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM tracks WHERE id = ?1 AND project_id = ?2)",
                params![track_id, project_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("Could not verify version before deletion: {error}"))?;
        if !belongs_to_project {
            return Err("Track version no longer exists in this project.".to_string());
        }
    }
    capsule_deletion_impact(&connection, &project_id, track_id.as_deref())
}

#[tauri::command(rename = "deleteTrackVersion", rename_all = "camelCase")]
fn delete_track_version(
    app: tauri::AppHandle,
    project_id: String,
    track_id: String,
) -> Result<ProjectDto, String> {
    let _operation = lock_library_operation()?;
    let roots = prepare_storage(&app)?;
    let mut connection = open_database(&roots.db_path)?;
    let version = connection
        .query_row(
            "SELECT managed_file_ref, COALESCE(group_id, id), version_position, is_current,
                    (SELECT COUNT(*) FROM tracks sibling
                     WHERE sibling.project_id = tracks.project_id
                       AND COALESCE(sibling.group_id, sibling.id) = COALESCE(tracks.group_id, tracks.id))
             FROM tracks WHERE id = ?1 AND project_id = ?2",
            params![track_id, project_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)? != 0,
                    row.get::<_, i64>(4)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("Could not locate track version: {error}"))?
        .ok_or_else(|| "Track version no longer exists in this project.".to_string())?;
    if version.4 <= 1 {
        return Err("A track must keep one version.".to_string());
    }
    let replacement_id = if version.3 {
        connection
            .query_row(
                "SELECT id FROM tracks
                 WHERE project_id = ?1 AND COALESCE(group_id, id) = ?2 AND id <> ?3
                 ORDER BY version_position ASC, position ASC LIMIT 1",
                params![project_id, version.1, track_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| format!("Could not choose a replacement version: {error}"))?
    } else {
        None
    };
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Could not begin version removal: {error}"))?;
    delete_capsules_referencing_track(&transaction, &track_id)?;
    if let Some(replacement_id) = replacement_id {
        transaction
            .execute(
                "UPDATE tracks SET is_current = 1 WHERE id = ?1 AND project_id = ?2",
                params![replacement_id, project_id],
            )
            .map_err(|error| format!("Could not select replacement version: {error}"))?;
    }
    transaction
        .execute(
            "DELETE FROM tracks WHERE id = ?1 AND project_id = ?2",
            params![track_id, project_id],
        )
        .map_err(|error| format!("Could not remove track version: {error}"))?;
    transaction
        .execute(
            "UPDATE tracks SET version_position = version_position - 1
             WHERE project_id = ?1 AND COALESCE(group_id, id) = ?2 AND version_position > ?3",
            params![project_id, version.1, version.2],
        )
        .map_err(|error| format!("Could not compact version order: {error}"))?;
    transaction
        .execute(
            "UPDATE projects SET updated_at = ?1 WHERE id = ?2",
            params![now_ms(), project_id],
        )
        .map_err(|error| format!("Could not update project timestamp: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Could not commit version removal: {error}"))?;
    let _ = remove_managed_file_if_unreferenced(&connection, &roots, &version.0);
    load_project(&connection, &roots, &project_id)
}

#[tauri::command(rename = "saveNote", rename_all = "camelCase")]
fn save_note(
    app: tauri::AppHandle,
    project_id: Option<String>,
    track_id: Option<String>,
    text: String,
) -> Result<NoteDto, String> {
    let _operation = lock_library_operation()?;
    if project_id.is_some() == track_id.is_some() {
        return Err("A note must belong to one project or one track.".to_string());
    }
    let roots = prepare_storage(&app)?;
    let connection = open_database(&roots.db_path)?;
    let timestamp = now_ms();
    if let Some(project_id) = project_id {
        let exists: Option<String> = connection
            .query_row(
                "SELECT id FROM projects WHERE id = ?1",
                params![project_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("Could not verify project note: {error}"))?;
        if exists.is_none() {
            return Err("Project no longer exists.".to_string());
        }
        connection
            .execute(
                "INSERT INTO notes (id, project_id, track_id, text, updated_at) VALUES (?1, ?2, NULL, ?3, ?4)
                 ON CONFLICT(project_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at",
                params![Uuid::new_v4().to_string(), project_id, text, timestamp],
            )
            .map_err(|error| format!("Could not save project note: {error}"))?;
        connection
            .execute(
                "UPDATE projects SET updated_at = ?1 WHERE id = ?2",
                params![timestamp, project_id],
            )
            .map_err(|error| format!("Could not update project timestamp: {error}"))?;
        load_project_note(&connection, &project_id)?
            .ok_or_else(|| "Could not load saved note.".to_string())
    } else if let Some(track_id) = track_id {
        let project_id: Option<String> = connection
            .query_row(
                "SELECT project_id FROM tracks WHERE id = ?1",
                params![track_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("Could not verify track note: {error}"))?;
        let project_id = project_id.ok_or_else(|| "Track no longer exists.".to_string())?;
        connection
            .execute(
                "INSERT INTO notes (id, project_id, track_id, text, updated_at) VALUES (?1, NULL, ?2, ?3, ?4)
                 ON CONFLICT(track_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at",
                params![Uuid::new_v4().to_string(), track_id, text, timestamp],
            )
            .map_err(|error| format!("Could not save track note: {error}"))?;
        connection
            .execute(
                "UPDATE projects SET updated_at = ?1 WHERE id = ?2",
                params![timestamp, project_id],
            )
            .map_err(|error| format!("Could not update project timestamp: {error}"))?;
        load_track_note(&connection, &track_id)?
            .ok_or_else(|| "Could not load saved note.".to_string())
    } else {
        unreachable!();
    }
}

#[tauri::command(rename = "deleteTrack", rename_all = "camelCase")]
fn delete_track(
    app: tauri::AppHandle,
    project_id: String,
    track_id: String,
) -> Result<ProjectDto, String> {
    let _operation = lock_library_operation()?;
    let roots = prepare_storage(&app)?;
    let mut connection = open_database(&roots.db_path)?;
    let managed_file_ref: Option<String> = connection
        .query_row(
            "SELECT managed_file_ref FROM tracks WHERE id = ?1 AND project_id = ?2",
            params![track_id, project_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Could not locate track: {error}"))?;
    let managed_file_ref =
        managed_file_ref.ok_or_else(|| "Track no longer exists in this project.".to_string())?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Could not begin track removal: {error}"))?;
    delete_capsules_referencing_track(&transaction, &track_id)?;
    transaction
        .execute(
            "DELETE FROM tracks WHERE id = ?1 AND project_id = ?2",
            params![track_id, project_id],
        )
        .map_err(|error| format!("Could not remove track: {error}"))?;
    transaction
        .execute(
            "UPDATE projects SET updated_at = ?1 WHERE id = ?2",
            params![now_ms(), project_id],
        )
        .map_err(|error| format!("Could not update project timestamp: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Could not commit track removal: {error}"))?;
    // The record deletion is already committed. A cleanup failure must not report a false
    // deletion failure; the helper queues any recoverable filesystem work for startup retry.
    let _ = remove_managed_file_if_unreferenced(&connection, &roots, &managed_file_ref);
    load_project(&connection, &roots, &project_id)
}

#[tauri::command(rename = "deleteProject", rename_all = "camelCase")]
fn delete_project(app: tauri::AppHandle, project_id: String) -> Result<(), String> {
    let _operation = lock_library_operation()?;
    let roots = prepare_storage(&app)?;
    let mut connection = open_database(&roots.db_path)?;
    let artwork_ref = project_artwork_ref(&connection, &project_id)?
        .ok_or_else(|| "Project no longer exists.".to_string())?;
    let mut statement = connection
        .prepare("SELECT managed_file_ref FROM tracks WHERE project_id = ?1")
        .map_err(|error| format!("Could not collect managed files: {error}"))?;
    let managed_refs = statement
        .query_map(params![project_id], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Could not read managed files: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not decode managed files: {error}"))?;
    drop(statement);
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Could not begin project removal: {error}"))?;
    transaction
        .execute("DELETE FROM projects WHERE id = ?1", params![project_id])
        .map_err(|error| format!("Could not remove project: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Could not commit project removal: {error}"))?;
    for managed_file_ref in managed_refs {
        // The record deletion above is complete. File cleanup is best effort and is retried from
        // cleanup_queue on the next safe startup if the filesystem is temporarily unavailable.
        let _ = remove_managed_file_if_unreferenced(&connection, &roots, &managed_file_ref);
    }
    if let Some(artwork_ref) = artwork_ref {
        let references: i64 = match connection.query_row(
            "SELECT COUNT(*) FROM projects WHERE artwork_ref = ?1",
            params![artwork_ref],
            |row| row.get(0),
        ) {
            Ok(references) => references,
            Err(_) => {
                let _ = queue_managed_cleanup(&connection, &format!("artwork/{project_id}"));
                1
            }
        };
        if references == 0 {
            if let Ok(artwork_path) = safe_managed_path(&roots, &artwork_ref) {
                if let Some(artwork_dir) = artwork_path.parent().filter(|path| path.is_dir()) {
                    if fs::remove_dir_all(artwork_dir).is_err() {
                        let _ =
                            queue_managed_cleanup(&connection, &format!("artwork/{project_id}"));
                    }
                }
            }
        }
    }
    if let Ok(project_audio_dir) = safe_managed_path(&roots, &format!("audio/{project_id}")) {
        if project_audio_dir.is_dir() {
            if fs::remove_dir(&project_audio_dir).is_err() {
                let _ = queue_managed_cleanup(&connection, &format!("audio/{project_id}"));
            }
        }
    }
    Ok(())
}

#[tauri::command(rename = "setProjectArtwork", rename_all = "camelCase")]
fn set_project_artwork(
    app: tauri::AppHandle,
    project_id: String,
    source_path: String,
) -> Result<ProjectDto, String> {
    let _operation = lock_library_operation()?;
    let roots = prepare_storage(&app)?;
    let final_dir = project_storage_dir(&roots.artwork_dir, &project_id)?;
    let source = PathBuf::from(&source_path);
    if !source.is_file() {
        return Err("That artwork file could not be found.".to_string());
    }
    if !supported_artwork(&source) {
        return Err("Artwork must be PNG, JPG, JPEG, or WEBP.".to_string());
    }
    let connection = open_database(&roots.db_path)?;
    let exists: Option<String> = connection
        .query_row(
            "SELECT id FROM projects WHERE id = ?1",
            params![project_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Could not verify project: {error}"))?;
    if exists.is_none() {
        return Err("Project no longer exists.".to_string());
    }

    let artwork_revision = Uuid::new_v4();
    let batch_dir = roots
        .staging_dir
        .join(format!("artwork-{artwork_revision}"));
    fs::create_dir_all(&batch_dir).map_err(|error| format!("Could not stage artwork: {error}"))?;
    let staged_source = batch_dir.join(format!("source.{}", extension(&source)));
    fs::copy(&source, &staged_source)
        .map_err(|error| format!("Could not copy artwork into staging: {error}"))?;
    let thumbnail = image::open(&staged_source)
        .map_err(|_| "OPAL could not decode that artwork image.".to_string())?
        .thumbnail(1200, 1200);
    let thumbnail_name = format!("thumb-{artwork_revision}.jpg");
    let thumbnail_path = batch_dir.join(&thumbnail_name);
    thumbnail
        .save_with_format(&thumbnail_path, ImageFormat::Jpeg)
        .map_err(|error| format!("Could not create artwork thumbnail: {error}"))?;

    let backup_dir = roots.artwork_dir.join(format!(".backup-{project_id}"));
    if backup_dir.exists() {
        fs::remove_dir_all(&backup_dir)
            .map_err(|error| format!("Could not clear artwork backup: {error}"))?;
    }
    if final_dir.exists() {
        fs::rename(&final_dir, &backup_dir)
            .map_err(|error| format!("Could not stage the existing artwork: {error}"))?;
    }
    if let Err(error) = fs::rename(&batch_dir, &final_dir) {
        if backup_dir.exists() {
            let _ = fs::rename(&backup_dir, &final_dir);
        }
        return Err(format!("Could not commit artwork: {error}"));
    }
    let artwork_ref = format!("artwork/{project_id}/{thumbnail_name}");
    if let Err(error) = connection.execute(
        "UPDATE projects SET artwork_ref = ?1, updated_at = ?2 WHERE id = ?3",
        params![artwork_ref, now_ms(), project_id],
    ) {
        let _ = fs::remove_dir_all(&final_dir);
        if backup_dir.exists() {
            let _ = fs::rename(&backup_dir, &final_dir);
        }
        return Err(format!("Could not save artwork reference: {error}"));
    }
    if backup_dir.exists() {
        let _ = fs::remove_dir_all(&backup_dir);
    }
    load_project(&connection, &roots, &project_id)
}

#[tauri::command(rename = "removeProjectArtwork", rename_all = "camelCase")]
fn remove_project_artwork(app: tauri::AppHandle, project_id: String) -> Result<ProjectDto, String> {
    let _operation = lock_library_operation()?;
    let roots = prepare_storage(&app)?;
    let artwork_dir = project_storage_dir(&roots.artwork_dir, &project_id)?;
    let connection = open_database(&roots.db_path)?;
    let changed = connection
        .execute(
            "UPDATE projects SET artwork_ref = NULL, updated_at = ?1 WHERE id = ?2",
            params![now_ms(), project_id],
        )
        .map_err(|error| format!("Could not remove artwork reference: {error}"))?;
    if changed == 0 {
        return Err("Project no longer exists.".to_string());
    }
    if artwork_dir.exists() {
        if fs::remove_dir_all(&artwork_dir).is_err() {
            let _ = queue_managed_cleanup(&connection, &format!("artwork/{project_id}"));
        }
    }
    load_project(&connection, &roots, &project_id)
}

#[tauri::command(rename = "importAudioFiles", rename_all = "camelCase")]
fn import_audio_files(
    app: tauri::AppHandle,
    state: tauri::State<'_, ImportState>,
    project_id: String,
    paths: Vec<String>,
    allow_duplicates: bool,
    track_group_id: Option<String>,
) -> Result<ImportSummary, String> {
    let _operation = lock_library_operation()?;
    let _guard = state.begin(&project_id)?;
    import_audio_files_inner(app, project_id, paths, allow_duplicates, track_group_id)
}

fn import_audio_files_inner(
    app: tauri::AppHandle,
    project_id: String,
    paths: Vec<String>,
    allow_duplicates: bool,
    track_group_id: Option<String>,
) -> Result<ImportSummary, String> {
    let roots = prepare_storage(&app)?;
    let project_audio_dir = project_storage_dir(&roots.audio_dir, &project_id)?;
    if paths.is_empty() {
        return Ok(ImportSummary {
            results: Vec::new(),
            duplicate_paths: Vec::new(),
            imported_count: 0,
        });
    }
    let mut connection = open_database(&roots.db_path)?;
    let project_exists: Option<String> = connection
        .query_row(
            "SELECT id FROM projects WHERE id = ?1",
            params![project_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Could not verify project: {error}"))?;
    if project_exists.is_none() {
        return Err("Project no longer exists.".to_string());
    }
    let target_group_id = if let Some(group_id) = track_group_id {
        let exists: Option<String> = connection
            .query_row(
                "SELECT id FROM track_groups WHERE id = ?1 AND project_id = ?2",
                params![group_id, project_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("Could not verify track group: {error}"))?;
        Some(exists.ok_or_else(|| "Track group no longer exists in this project.".to_string())?)
    } else {
        None
    };
    let mut position: i64 = connection
        .query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM tracks WHERE project_id = ?1",
            params![project_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not determine track order: {error}"))?;
    let batch_dir = roots.staging_dir.join(format!("audio-{}", Uuid::new_v4()));
    fs::create_dir_all(&batch_dir)
        .map_err(|error| format!("Could not create import staging: {error}"))?;
    let total = paths.len();
    let mut results = Vec::with_capacity(total);
    let mut duplicate_paths = Vec::new();
    let mut imported_count = 0;
    let mut seen_hashes = HashSet::new();

    for (index, source_string) in paths.iter().enumerate() {
        let source = PathBuf::from(source_string);
        let file_name = display_file_name(&source);
        send_import_progress(
            &app,
            ImportProgress {
                project_id: project_id.clone(),
                current: index,
                total,
                file_name: file_name.clone(),
                status: "processing".to_string(),
                message: "Checking file…".to_string(),
            },
        );
        if !source.is_file() {
            results.push(ImportItemResult {
                path: source_string.clone(),
                file_name: file_name.clone(),
                status: "failed".to_string(),
                message: "The source file could not be found.".to_string(),
                track: None,
            });
            send_import_progress(
                &app,
                ImportProgress {
                    project_id: project_id.clone(),
                    current: index + 1,
                    total,
                    file_name,
                    status: "failed".to_string(),
                    message: "Source file not found.".to_string(),
                },
            );
            continue;
        }
        if !supported_audio(&source) {
            results.push(ImportItemResult {
                path: source_string.clone(),
                file_name: file_name.clone(),
                status: "unsupported".to_string(),
                message: "Choose WAV, MP3, FLAC, AIFF, or M4A.".to_string(),
                track: None,
            });
            send_import_progress(
                &app,
                ImportProgress {
                    project_id: project_id.clone(),
                    current: index + 1,
                    total,
                    file_name,
                    status: "unsupported".to_string(),
                    message: "Format is not supported for import.".to_string(),
                },
            );
            continue;
        }
        let source_hash = match hash_file(&source) {
            Ok(hash) => hash,
            Err(message) => {
                results.push(ImportItemResult {
                    path: source_string.clone(),
                    file_name: file_name.clone(),
                    status: "failed".to_string(),
                    message: message.clone(),
                    track: None,
                });
                send_import_progress(
                    &app,
                    ImportProgress {
                        project_id: project_id.clone(),
                        current: index + 1,
                        total,
                        file_name,
                        status: "failed".to_string(),
                        message,
                    },
                );
                continue;
            }
        };
        let duplicate: Option<String> = connection
            .query_row(
                "SELECT id FROM tracks WHERE project_id = ?1 AND source_hash = ?2 LIMIT 1",
                params![project_id, source_hash],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("Could not check duplicate tracks: {error}"))?;
        let duplicate_in_batch = !seen_hashes.insert(source_hash.clone());
        if (duplicate.is_some() || duplicate_in_batch) && !allow_duplicates {
            duplicate_paths.push(source_string.clone());
            results.push(ImportItemResult {
                path: source_string.clone(),
                file_name: file_name.clone(),
                status: "duplicate".to_string(),
                message: if duplicate_in_batch {
                    "This file appears more than once in the import."
                } else {
                    "Already in this project. Import again if you want a second copy."
                }
                .to_string(),
                track: None,
            });
            send_import_progress(
                &app,
                ImportProgress {
                    project_id: project_id.clone(),
                    current: index + 1,
                    total,
                    file_name,
                    status: "duplicate".to_string(),
                    message: "Duplicate found; waiting for your choice.".to_string(),
                },
            );
            continue;
        }

        let metadata = match extract_audio_metadata(&source) {
            Ok(metadata) => metadata,
            Err(message) => {
                record_diagnostic_error("Audio import rejected a file");
                results.push(ImportItemResult {
                    path: source_string.clone(),
                    file_name: file_name.clone(),
                    status: "failed".to_string(),
                    message: message.clone(),
                    track: None,
                });
                send_import_progress(
                    &app,
                    ImportProgress {
                        project_id: project_id.clone(),
                        current: index + 1,
                        total,
                        file_name,
                        status: "failed".to_string(),
                        message,
                    },
                );
                continue;
            }
        };
        let (
            group_id,
            group_title,
            group_position,
            version_position,
            is_current,
            is_new_group,
            source_track_id,
        ) = if let Some(group_id) = target_group_id.as_ref() {
            let group = connection
                .query_row(
                    "SELECT title, position FROM track_groups WHERE id = ?1 AND project_id = ?2",
                    params![group_id, project_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                )
                .map_err(|error| format!("Could not load track group: {error}"))?;
            let version_position: i64 = connection
                    .query_row(
                        "SELECT COALESCE(MAX(version_position), -1) + 1 FROM tracks WHERE project_id = ?1 AND COALESCE(group_id, id) = ?2",
                        params![project_id, group_id],
                        |row| row.get(0),
                    )
                    .map_err(|error| format!("Could not determine version order: {error}"))?;
            let source_track_id: Option<String> = connection
                    .query_row(
                        "SELECT id FROM tracks WHERE project_id = ?1 AND group_id = ?2 AND is_current = 1 LIMIT 1",
                        params![project_id, group_id],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(|error| format!("Could not locate current track version: {error}"))?;
            (
                group_id.clone(),
                group.0,
                group.1,
                version_position,
                false,
                false,
                source_track_id,
            )
        } else {
            (
                    Uuid::new_v4().to_string(),
                    metadata.title.clone(),
                    connection
                        .query_row(
                            "SELECT COALESCE(MAX(position), -1) + 1 FROM track_groups WHERE project_id = ?1",
                            params![project_id],
                            |row| row.get(0),
                        )
                        .map_err(|error| format!("Could not determine track group order: {error}"))?,
                    0,
                    true,
                    true,
                    None,
                )
        };
        let track_id = Uuid::new_v4().to_string();
        let staged_file = batch_dir.join(format!("{track_id}.{}", extension(&source)));
        if let Err(error) = copy_import_to_staging(&source, &staged_file, None) {
            let message = error;
            results.push(ImportItemResult {
                path: source_string.clone(),
                file_name: file_name.clone(),
                status: "failed".to_string(),
                message: message.clone(),
                track: None,
            });
            send_import_progress(
                &app,
                ImportProgress {
                    project_id: project_id.clone(),
                    current: index + 1,
                    total,
                    file_name,
                    status: "failed".to_string(),
                    message,
                },
            );
            continue;
        }
        if let Err(error) = fs::create_dir_all(&project_audio_dir) {
            let _ = fs::remove_file(&staged_file);
            let message = format!("Could not create managed audio storage: {error}");
            results.push(ImportItemResult {
                path: source_string.clone(),
                file_name: file_name.clone(),
                status: "failed".to_string(),
                message: message.clone(),
                track: None,
            });
            send_import_progress(
                &app,
                ImportProgress {
                    project_id: project_id.clone(),
                    current: index + 1,
                    total,
                    file_name,
                    status: "failed".to_string(),
                    message,
                },
            );
            continue;
        }
        let managed_file_ref = format!("audio/{project_id}/{track_id}.{}", extension(&source));
        let managed_path = roots.root.join(&managed_file_ref);
        let version_name = if version_position == 0 {
            "Original".to_string()
        } else {
            format!("Bounce {}", version_position + 1)
        };
        let track = TrackDto {
            id: track_id.clone(),
            project_id: project_id.clone(),
            group_id: group_id.clone(),
            title: group_title.clone(),
            source_title: metadata.title,
            position: group_position,
            version_name: version_name.clone(),
            version_position,
            is_current,
            version_count: version_position as usize + 1,
            duration_ms: metadata.duration_ms,
            duration: format_track_duration(metadata.duration_ms),
            format: extension(&source).to_uppercase(),
            managed_file_ref: managed_file_ref.clone(),
            managed_file_path: Some(managed_path.to_string_lossy().into_owned()),
            note: None,
            moments: Vec::new(),
        };
        let new_group =
            is_new_group.then_some((group_id.as_str(), group_title.as_str(), group_position));
        if let Err(error) = commit_imported_track(
            &mut connection,
            &staged_file,
            &managed_path,
            new_group,
            &track,
            position,
            &source_hash,
            source_track_id.as_deref(),
            None,
        ) {
            let _ = fs::remove_file(&staged_file);
            let message = error;
            results.push(ImportItemResult {
                path: source_string.clone(),
                file_name: file_name.clone(),
                status: "failed".to_string(),
                message: message.clone(),
                track: None,
            });
            send_import_progress(
                &app,
                ImportProgress {
                    project_id: project_id.clone(),
                    current: index + 1,
                    total,
                    file_name,
                    status: "failed".to_string(),
                    message,
                },
            );
            continue;
        }
        let message = metadata
            .warning
            .unwrap_or_else(|| "Stored safely in OPAL managed storage.".to_string());
        results.push(ImportItemResult {
            path: source_string.clone(),
            file_name: file_name.clone(),
            status: "imported".to_string(),
            message: message.clone(),
            track: Some(track),
        });
        imported_count += 1;
        position += 1;
        send_import_progress(
            &app,
            ImportProgress {
                project_id: project_id.clone(),
                current: index + 1,
                total,
                file_name,
                status: "imported".to_string(),
                message,
            },
        );
    }
    let _ = fs::remove_dir_all(&batch_dir);
    Ok(ImportSummary {
        results,
        duplicate_paths,
        imported_count,
    })
}

fn directory_size(path: &Path) -> u64 {
    if path.is_file() {
        return fs::metadata(path)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
    }
    fs::read_dir(path)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| directory_size(&entry.path()))
        .sum()
}

fn copy_directory(source: &Path, destination: &Path) -> Result<(), String> {
    if !source.is_dir() {
        return Err(format!(
            "Managed backup folder is missing: {}",
            source.display()
        ));
    }
    fs::create_dir_all(destination)
        .map_err(|error| format!("Could not create backup folder: {error}"))?;
    for entry in
        fs::read_dir(source).map_err(|error| format!("Could not read managed storage: {error}"))?
    {
        let entry =
            entry.map_err(|error| format!("Could not read managed storage entry: {error}"))?;
        let source_path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Could not inspect managed storage entry: {error}"))?;
        if file_type.is_symlink() {
            return Err("Managed backup storage cannot contain symbolic links.".to_string());
        }
        let destination_path = destination.join(entry.file_name());
        if file_type.is_dir() {
            copy_directory(&source_path, &destination_path)?;
        } else if file_type.is_file() {
            fs::copy(&source_path, &destination_path)
                .map_err(|error| format!("Could not copy backup file: {error}"))?;
        } else {
            return Err("Managed backup storage contains a non-file asset.".to_string());
        }
    }
    Ok(())
}

fn reveal_in_file_manager(path: &Path) -> Result<(), String> {
    let target = if path.exists() {
        path.to_path_buf()
    } else {
        path.parent().unwrap_or(path).to_path_buf()
    };
    #[cfg(target_os = "macos")]
    let result = if path.is_file() {
        std::process::Command::new("open")
            .args(["-R"])
            .arg(&target)
            .status()
    } else {
        std::process::Command::new("open").arg(&target).status()
    };
    #[cfg(target_os = "windows")]
    let result = if path.is_file() {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", target.display()))
            .status()
    } else {
        std::process::Command::new("explorer").arg(&target).status()
    };
    #[cfg(target_os = "linux")]
    let result = std::process::Command::new("xdg-open").arg(&target).status();
    result
        .map_err(|error| format!("Could not reveal the OPAL location: {error}"))
        .and_then(|status| {
            if status.success() {
                Ok(())
            } else {
                Err("The file manager could not open this location.".to_string())
            }
        })
}

fn storage_counts(connection: &Connection) -> Result<(usize, usize), String> {
    let projects: i64 = connection
        .query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))
        .map_err(|error| format!("Could not count projects: {error}"))?;
    let tracks: i64 = connection
        .query_row("SELECT COUNT(*) FROM tracks", [], |row| row.get(0))
        .map_err(|error| format!("Could not count tracks: {error}"))?;
    Ok((projects as usize, tracks as usize))
}

fn backup_asset_inventory(
    roots: &StorageRoots,
    connection: &Connection,
) -> Result<Vec<BackupAsset>, String> {
    for directory in [&roots.audio_dir, &roots.artwork_dir] {
        let metadata = fs::symlink_metadata(directory)
            .map_err(|error| format!("Could not inspect managed asset folder: {error}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(
                "Managed audio and artwork folders must be regular directories.".to_string(),
            );
        }
    }
    fn add_tree(
        root: &Path,
        directory: &Path,
        assets: &mut Vec<BackupAsset>,
    ) -> Result<(), String> {
        let mut entries = fs::read_dir(directory)
            .map_err(|error| format!("Could not inspect managed backup assets: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Could not inspect managed backup assets: {error}"))?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let path = entry.path();
            let kind = entry
                .file_type()
                .map_err(|error| format!("Could not inspect managed backup asset: {error}"))?;
            if kind.is_symlink() {
                return Err(
                    "A managed backup asset is a symbolic link and cannot be verified.".to_string(),
                );
            }
            if kind.is_dir() {
                add_tree(root, &path, assets)?;
                continue;
            }
            if !kind.is_file() {
                return Err("A managed backup asset is not a regular file.".to_string());
            }
            let relative = path
                .strip_prefix(root)
                .map_err(|_| "A managed backup asset escaped its library folder.".to_string())?;
            let relative = relative
                .components()
                .map(|component| match component {
                    std::path::Component::Normal(value) => value
                        .to_str()
                        .ok_or_else(|| "A managed backup path is not valid Unicode.".to_string()),
                    _ => Err("A managed backup path is not normalized.".to_string()),
                })
                .collect::<Result<Vec<_>, _>>()?
                .join("/");
            let metadata = fs::metadata(&path)
                .map_err(|error| format!("Could not inspect managed backup asset: {error}"))?;
            let mut file = File::open(&path)
                .map_err(|error| format!("Could not read managed backup asset: {error}"))?;
            let mut hasher = Sha256::new();
            let mut buffer = [0_u8; 64 * 1024];
            loop {
                let bytes = file
                    .read(&mut buffer)
                    .map_err(|error| format!("Could not verify managed backup asset: {error}"))?;
                if bytes == 0 {
                    break;
                }
                hasher.update(&buffer[..bytes]);
            }
            let sha256 = hasher
                .finalize()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect();
            assets.push(BackupAsset {
                path: relative,
                size_bytes: metadata.len(),
                sha256,
            });
        }
        Ok(())
    }

    for directory in [&roots.audio_dir, &roots.artwork_dir] {
        if !directory.is_dir() {
            return Err(format!(
                "Managed asset folder is missing: {}",
                directory.display()
            ));
        }
    }

    let mut referenced = HashSet::new();
    let mut statement = connection
        .prepare("SELECT managed_file_ref FROM tracks")
        .map_err(|error| format!("Could not validate managed audio references: {error}"))?;
    let references = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Could not read managed audio references: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read managed audio references: {error}"))?;
    drop(statement);
    for reference in references {
        if !reference.starts_with("audio/") {
            return Err(format!(
                "A track references an invalid managed audio path: {reference}"
            ));
        }
        let path = safe_managed_path(roots, &reference)?;
        if !path.is_file() {
            return Err(format!(
                "A referenced managed audio file is missing: {reference}"
            ));
        }
        referenced.insert(reference);
    }
    let mut statement = connection
        .prepare("SELECT artwork_ref FROM projects WHERE artwork_ref IS NOT NULL")
        .map_err(|error| format!("Could not validate artwork references: {error}"))?;
    let references = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Could not read artwork references: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read artwork references: {error}"))?;
    drop(statement);
    for reference in references {
        if !reference.starts_with("artwork/") {
            return Err(format!(
                "A project references an invalid artwork path: {reference}"
            ));
        }
        let path = safe_managed_path(roots, &reference)?;
        if !path.is_file() {
            return Err(format!("A referenced artwork file is missing: {reference}"));
        }
        referenced.insert(reference);
    }

    let mut assets = Vec::new();
    add_tree(&roots.root, &roots.audio_dir, &mut assets)?;
    add_tree(&roots.root, &roots.artwork_dir, &mut assets)?;
    let inventoried = assets
        .iter()
        .map(|asset| asset.path.clone())
        .collect::<HashSet<_>>();
    if let Some(missing) = referenced.iter().find(|path| !inventoried.contains(*path)) {
        return Err(format!(
            "A referenced managed asset is missing from the backup: {missing}"
        ));
    }
    Ok(assets)
}

fn backup_manifest_for(
    connection: &Connection,
    roots: &StorageRoots,
    exported_at: i64,
) -> Result<BackupManifest, String> {
    let (project_count, track_count) = storage_counts(connection)?;
    Ok(BackupManifest {
        format_version: 1,
        app_version: APP_VERSION.to_string(),
        exported_at,
        database: "opal.sqlite".to_string(),
        audio_directory: "audio".to_string(),
        artwork_directory: "artwork".to_string(),
        project_count,
        track_count,
        assets: backup_asset_inventory(roots, connection)?,
    })
}

fn validate_backup(source: &Path) -> Result<BackupManifest, String> {
    let manifest_path = source.join("manifest.json");
    let database_path = source.join("opal.sqlite");
    if !manifest_path.is_file()
        || !database_path.is_file()
        || !source.join("audio").is_dir()
        || !source.join("artwork").is_dir()
    {
        return Err("This folder is not a complete OPAL backup.".to_string());
    }
    for (path, should_be_directory) in [
        (manifest_path.clone(), false),
        (database_path.clone(), false),
        (source.join("audio"), true),
        (source.join("artwork"), true),
    ] {
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("Could not inspect OPAL backup entry: {error}"))?;
        if metadata.file_type().is_symlink()
            || (should_be_directory && !metadata.is_dir())
            || (!should_be_directory && !metadata.is_file())
        {
            return Err("OPAL backup entries must be regular files and directories.".to_string());
        }
    }
    let manifest: BackupManifest = serde_json::from_slice(
        &fs::read(&manifest_path)
            .map_err(|error| format!("Could not read backup manifest: {error}"))?,
    )
    .map_err(|error| format!("The OPAL backup manifest is invalid: {error}"))?;
    if manifest.format_version != 1
        || manifest.database != "opal.sqlite"
        || manifest.audio_directory != "audio"
        || manifest.artwork_directory != "artwork"
        || manifest.app_version.trim().is_empty()
        || manifest.exported_at <= 0
    {
        return Err("This OPAL backup was created by an incompatible version.".to_string());
    }
    let connection = open_database(&database_path)?;
    database_integrity(&connection)?;
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| format!("The OPAL backup database is unreadable: {error}"))?;
    if version > DATABASE_VERSION {
        return Err("COMPATIBILITY_REQUIRED: This backup was created by a newer OPAL version. Install a newer OPAL build to restore it. The current library has not been changed.".to_string());
    }
    let mut statement = connection
        .prepare("SELECT id FROM projects")
        .map_err(|error| format!("Could not validate backup project IDs: {error}"))?;
    let project_ids = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Could not read backup project IDs: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read backup project IDs: {error}"))?;
    drop(statement);
    for project_id in project_ids {
        validate_project_storage_id(&project_id)?;
    }
    let (project_count, track_count) = storage_counts(&connection)?;
    if project_count != manifest.project_count || track_count != manifest.track_count {
        return Err("The OPAL backup manifest does not match its database.".to_string());
    }
    let backup_roots = StorageRoots {
        root: source.to_path_buf(),
        db_path: database_path,
        audio_dir: source.join("audio"),
        artwork_dir: source.join("artwork"),
        staging_dir: source.join(".staging"),
    };
    let actual_assets = backup_asset_inventory(&backup_roots, &connection)?;
    if !manifest.assets.is_empty() && manifest.assets != actual_assets {
        return Err("The OPAL backup manifest does not match its managed assets.".to_string());
    }
    Ok(manifest)
}

fn storage_info_for(roots: &StorageRoots) -> Result<StorageInfo, String> {
    let connection = open_database(&roots.db_path)?;
    database_integrity(&connection)?;
    let (project_count, track_count) = storage_counts(&connection)?;
    let database_bytes = fs::metadata(&roots.db_path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let audio_bytes = directory_size(&roots.audio_dir);
    let artwork_bytes = directory_size(&roots.artwork_dir);
    let backup_count = fs::read_dir(roots.root.join("backups"))
        .ok()
        .map(|entries| entries.flatten().count())
        .unwrap_or(0);
    Ok(StorageInfo {
        folder_path: roots.root.to_string_lossy().into_owned(),
        database_path: roots.db_path.to_string_lossy().into_owned(),
        total_bytes: database_bytes + audio_bytes + artwork_bytes,
        database_bytes,
        audio_bytes,
        artwork_bytes,
        project_count,
        track_count,
        backup_count,
    })
}

#[tauri::command(rename = "getStorageInfo", rename_all = "camelCase")]
fn get_storage_info(app: tauri::AppHandle) -> Result<StorageInfo, String> {
    let _operation = lock_library_operation()?;
    let roots = storage_roots(&app)?;
    storage_info_for(&roots)
}

#[tauri::command(rename = "revealStorageFolder", rename_all = "camelCase")]
fn reveal_storage_folder(app: tauri::AppHandle) -> Result<(), String> {
    let roots = storage_roots(&app)?;
    reveal_in_file_manager(&roots.root)
}

#[tauri::command(rename = "revealManagedFile", rename_all = "camelCase")]
fn reveal_managed_file(app: tauri::AppHandle, managed_file_ref: String) -> Result<(), String> {
    let _operation = lock_library_operation()?;
    let roots = prepare_storage(&app)?;
    let path = safe_managed_path(&roots, &managed_file_ref)?;
    if !path.is_file() {
        return Err("This managed audio file is missing.".to_string());
    }
    reveal_in_file_manager(&path)
}

#[tauri::command(rename = "getAudioWaveform", rename_all = "camelCase")]
async fn get_audio_waveform(
    app: tauri::AppHandle,
    managed_file_ref: String,
) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = lock_library_operation()?;
        let roots = prepare_storage(&app)?;
        let path = safe_managed_path(&roots, &managed_file_ref)?;
        if !path.is_file() {
            return Err("This managed audio file is missing.".to_string());
        }
        if !supported_audio(&path) {
            return Err("This file type isn’t supported for audio analysis.".to_string());
        }
        let result = decode_audio_waveform(&path, 192);
        if result.is_err() {
            record_diagnostic_error("Audio waveform analysis failed");
        }
        result
    })
    .await
    .map_err(|error| format!("Audio analysis stopped unexpectedly: {error}"))?
}

fn create_verified_backup(
    roots: &StorageRoots,
    destination_root: &Path,
) -> Result<PathBuf, String> {
    create_verified_backup_with_failure(roots, destination_root, None)
}

fn create_verified_backup_with_failure(
    roots: &StorageRoots,
    destination_root: &Path,
    injected_failure: Option<BackupFailurePoint>,
) -> Result<PathBuf, String> {
    fs::create_dir_all(destination_root)
        .map_err(|error| format!("Could not create the OPAL backup folder: {error}"))?;
    let connection = open_database(&roots.db_path)?;
    database_integrity(&connection)?;
    let source_assets = backup_asset_inventory(roots, &connection)?;
    let backup_dir = destination_root.join(format!("OPAL Backup {} {}", now_ms(), Uuid::new_v4()));
    let staging_dir = destination_root.join(format!(".opal-backup-{}.partial", Uuid::new_v4()));
    fs::create_dir(&staging_dir)
        .map_err(|error| format!("Could not create the OPAL backup: {error}"))?;
    let result = (|| {
        let database_path = staging_dir.join("opal.sqlite");
        let mut snapshot = Connection::open(&database_path)
            .map_err(|error| format!("Could not stage the OPAL database: {error}"))?;
        Backup::new(&connection, &mut snapshot)
            .and_then(|backup| {
                backup.run_to_completion(128, std::time::Duration::from_millis(10), None)
            })
            .map_err(|error| {
                format!("Could not create a consistent OPAL database snapshot: {error}")
            })?;
        database_integrity(&snapshot)?;
        drop(snapshot);
        if injected_failure == Some(BackupFailurePoint::BeforeAudioCopy) {
            return Err("Injected backup copy failure before audio assets.".to_string());
        }
        copy_directory(&roots.audio_dir, &staging_dir.join("audio"))?;
        if injected_failure == Some(BackupFailurePoint::AfterAudioCopy) {
            return Err("Injected backup copy failure after audio assets.".to_string());
        }
        copy_directory(&roots.artwork_dir, &staging_dir.join("artwork"))?;
        let staged_roots = StorageRoots {
            root: staging_dir.clone(),
            db_path: database_path,
            audio_dir: staging_dir.join("audio"),
            artwork_dir: staging_dir.join("artwork"),
            staging_dir: staging_dir.join(".staging"),
        };
        let staged_connection = open_database(&staged_roots.db_path)?;
        database_integrity(&staged_connection)?;
        let manifest = backup_manifest_for(&staged_connection, &staged_roots, now_ms())?;
        if manifest.assets != source_assets {
            return Err(
                "Managed assets changed during backup creation. Retry the export.".to_string(),
            );
        }
        let manifest_json = serde_json::to_vec_pretty(&manifest)
            .map_err(|error| format!("Could not create the OPAL backup manifest: {error}"))?;
        let mut manifest_file = File::create(staging_dir.join("manifest.json"))
            .map_err(|error| format!("Could not write the OPAL backup manifest: {error}"))?;
        manifest_file
            .write_all(&manifest_json)
            .and_then(|_| manifest_file.sync_all())
            .map_err(|error| format!("Could not write the OPAL backup manifest: {error}"))?;
        drop(manifest_file);
        drop(staged_connection);
        validate_backup(&staging_dir)?;
        fs::rename(&staging_dir, &backup_dir)
            .map_err(|error| format!("Could not finalize the verified OPAL backup: {error}"))?;
        Ok(backup_dir.clone())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging_dir);
    }
    result
}

#[tauri::command(rename = "exportBackup", rename_all = "camelCase")]
fn export_backup(app: tauri::AppHandle, destination: String) -> Result<String, String> {
    let _operation = lock_library_operation()?;
    let roots = prepare_storage(&app)?;
    let destination = PathBuf::from(destination);
    let destination_root = canonical_backup_destination(&roots, &destination)?;
    create_verified_backup(&roots, &destination_root)
        .map(|backup| backup.to_string_lossy().into_owned())
}

fn canonical_backup_destination(
    roots: &StorageRoots,
    destination: &Path,
) -> Result<PathBuf, String> {
    if !destination.is_dir() {
        return Err("Choose a folder for the OPAL backup.".to_string());
    }
    let managed_root = roots
        .root
        .canonicalize()
        .map_err(|error| format!("Could not locate OPAL managed storage: {error}"))?;
    let destination_root = destination
        .canonicalize()
        .map_err(|error| format!("Could not access the backup destination: {error}"))?;
    if destination_root.starts_with(&managed_root) {
        return Err("Choose a backup destination outside OPAL managed storage.".to_string());
    }
    Ok(destination_root)
}

fn restore_paths(roots: &StorageRoots, id: &str) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let parsed =
        Uuid::parse_str(id).map_err(|_| "The OPAL restore journal is invalid.".to_string())?;
    if parsed.to_string() != id {
        return Err("The OPAL restore journal is invalid.".to_string());
    }
    Ok((
        roots.root.join(format!(".restore-{id}")),
        roots.root.join(format!(".rollback-{id}")),
        roots.root.join(format!(".restore-{id}.committed")),
    ))
}

fn remove_path(path: &Path) -> Result<(), String> {
    if path.is_dir() {
        fs::remove_dir_all(path)
            .map_err(|error| format!("Could not remove interrupted restore data: {error}"))
    } else if path.exists() {
        fs::remove_file(path)
            .map_err(|error| format!("Could not remove interrupted restore data: {error}"))
    } else {
        Ok(())
    }
}

fn rollback_restore(
    roots: &StorageRoots,
    rollback_dir: &Path,
    original_items: &[String],
) -> Result<(), String> {
    for name in ["opal.sqlite", "audio", "artwork"] {
        let previous = rollback_dir.join(name);
        if previous.exists() {
            let current = roots.root.join(name);
            remove_path(&current)?;
            fs::rename(&previous, &current)
                .map_err(|error| format!("Could not restore the previous {name}: {error}"))?;
        } else if !original_items.iter().any(|item| item == name) {
            remove_path(&roots.root.join(name))?;
        }
    }
    Ok(())
}

fn recover_interrupted_restore(roots: &StorageRoots) -> Result<(), String> {
    let journal_path = roots.root.join(".restore-journal.json");
    if !journal_path.is_file() {
        for entry in fs::read_dir(&roots.root)
            .map_err(|error| format!("Could not inspect abandoned restore staging: {error}"))?
        {
            let path = entry
                .map_err(|error| format!("Could not inspect abandoned restore staging: {error}"))?
                .path();
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            let possible_id = name
                .strip_prefix(".restore-")
                .or_else(|| name.strip_prefix(".rollback-"))
                .and_then(|value| value.strip_suffix(".committed").or(Some(value)));
            if possible_id.is_some_and(|value| Uuid::parse_str(value).is_ok()) {
                remove_path(&path)?;
            }
            if let Some(id) = name
                .strip_prefix(".restore-journal-")
                .and_then(|value| value.strip_suffix(".tmp"))
            {
                if Uuid::parse_str(id).is_ok() {
                    remove_path(&path)?;
                }
            }
        }
        return Ok(());
    }
    let journal: RestoreJournal =
        serde_json::from_slice(&fs::read(&journal_path).map_err(|error| {
            format!("RECOVERY_REQUIRED: Could not read restore recovery data: {error}")
        })?)
        .map_err(|error| format!("RECOVERY_REQUIRED: Restore recovery data is invalid: {error}"))?;
    let (staging_dir, rollback_dir, committed_marker) =
        restore_paths(roots, &journal.id).map_err(|error| format!("RECOVERY_REQUIRED: {error}"))?;
    if committed_marker.is_file() {
        remove_path(&rollback_dir)?;
        remove_path(&staging_dir)?;
        remove_path(&committed_marker)?;
        remove_path(&journal_path)?;
        return Ok(());
    }
    rollback_restore(roots, &rollback_dir, &journal.original_items).map_err(|error| {
        format!("RECOVERY_REQUIRED: OPAL could not finish restoring the previous library. {error}")
    })?;
    remove_path(&staging_dir)?;
    remove_path(&rollback_dir)?;
    remove_path(&journal_path)?;
    Ok(())
}

fn write_restore_journal(roots: &StorageRoots, journal: &RestoreJournal) -> Result<(), String> {
    let path = roots.root.join(".restore-journal.json");
    let temporary = roots
        .root
        .join(format!(".restore-journal-{}.tmp", journal.id));
    let bytes = serde_json::to_vec(journal)
        .map_err(|error| format!("Could not prepare restore recovery data: {error}"))?;
    let mut file = File::create(&temporary)
        .map_err(|error| format!("Could not prepare restore recovery data: {error}"))?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("Could not persist restore recovery data: {error}"))?;
    drop(file);
    fs::rename(&temporary, &path)
        .map_err(|error| format!("Could not activate restore recovery data: {error}"))
}

fn validate_restored_library(
    roots: &StorageRoots,
    expected: &BackupManifest,
) -> Result<(), String> {
    let connection = open_database(&roots.db_path)?;
    database_integrity(&connection)?;
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| format!("Could not verify restored database version: {error}"))?;
    if version > DATABASE_VERSION {
        return Err("COMPATIBILITY_REQUIRED: This backup needs a newer OPAL build.".to_string());
    }
    let (projects, tracks) = storage_counts(&connection)?;
    if projects != expected.project_count || tracks != expected.track_count {
        return Err("The restored database did not match the verified backup.".to_string());
    }
    let assets = backup_asset_inventory(roots, &connection)?;
    if !expected.assets.is_empty() && assets != expected.assets {
        return Err("Restored managed assets did not match the verified backup.".to_string());
    }
    Ok(())
}

fn maybe_fail_restore(
    injected: Option<RestoreFailurePoint>,
    phase: RestoreFailurePoint,
) -> Result<(), String> {
    if injected == Some(phase) {
        Err(format!("Injected restore failure at {phase:?}."))
    } else {
        Ok(())
    }
}

fn restore_verified_backup(
    roots: &StorageRoots,
    source: &Path,
    injected_failure: Option<RestoreFailurePoint>,
) -> Result<(), String> {
    restore_verified_backup_with_faults(roots, source, injected_failure, false)
}

fn restore_verified_backup_with_faults(
    roots: &StorageRoots,
    source: &Path,
    injected_failure: Option<RestoreFailurePoint>,
    inject_rollback_failure: bool,
) -> Result<(), String> {
    recover_interrupted_restore(roots)?;
    let manifest = validate_backup(source)?;
    let id = Uuid::new_v4().to_string();
    let (staging_dir, rollback_dir, committed_marker) = restore_paths(roots, &id)?;
    fs::create_dir(&staging_dir)
        .map_err(|error| format!("Could not stage the OPAL restore: {error}"))?;
    let stage_result = (|| {
        fs::copy(source.join("opal.sqlite"), staging_dir.join("opal.sqlite"))
            .map_err(|error| format!("Could not stage the OPAL database: {error}"))?;
        maybe_fail_restore(injected_failure, RestoreFailurePoint::DuringStagingCopy)?;
        copy_directory(&source.join("audio"), &staging_dir.join("audio"))?;
        copy_directory(&source.join("artwork"), &staging_dir.join("artwork"))?;
        fs::copy(
            source.join("manifest.json"),
            staging_dir.join("manifest.json"),
        )
        .map_err(|error| format!("Could not stage the OPAL manifest: {error}"))?;
        validate_backup(&staging_dir)?;
        create_verified_backup(roots, &roots.root.join("backups"))?;
        maybe_fail_restore(injected_failure, RestoreFailurePoint::AfterPreRestoreBackup)?;
        fs::create_dir(&rollback_dir)
            .map_err(|error| format!("Could not prepare pre-restore recovery: {error}"))?;
        let original_items = ["opal.sqlite", "audio", "artwork"]
            .iter()
            .filter(|name| roots.root.join(name).exists())
            .map(|name| (*name).to_string())
            .collect();
        write_restore_journal(
            roots,
            &RestoreJournal {
                id: id.clone(),
                original_items,
            },
        )?;
        Ok::<(), String>(())
    })();
    if let Err(error) = stage_result {
        let _ = remove_path(&staging_dir);
        let _ = remove_path(&rollback_dir);
        return Err(error);
    }

    let replacement = (|| {
        for name in ["opal.sqlite", "audio", "artwork"] {
            let current = roots.root.join(name);
            if current.exists() {
                fs::rename(&current, rollback_dir.join(name))
                    .map_err(|error| format!("Could not protect the current {name}: {error}"))?;
            }
            if name == "opal.sqlite" {
                maybe_fail_restore(injected_failure, RestoreFailurePoint::AfterDatabaseMoved)?;
            }
        }
        for name in ["opal.sqlite", "audio", "artwork"] {
            fs::rename(staging_dir.join(name), roots.root.join(name))
                .map_err(|error| format!("Could not install restored {name}: {error}"))?;
            if name == "audio" {
                maybe_fail_restore(injected_failure, RestoreFailurePoint::AfterAudioInstalled)?;
            }
        }
        validate_restored_library(roots, &manifest)?;
        maybe_fail_restore(injected_failure, RestoreFailurePoint::BeforeCommitMarker)?;
        let mut marker = File::create(&committed_marker)
            .map_err(|error| format!("Could not finalize the OPAL restore: {error}"))?;
        marker
            .write_all(b"OPAL restore committed\n")
            .and_then(|_| marker.sync_all())
            .map_err(|error| format!("Could not finalize the OPAL restore: {error}"))?;
        Ok::<(), String>(())
    })();

    if let Err(error) = replacement {
        let journal_bytes = fs::read(roots.root.join(".restore-journal.json")).map_err(|read_error| {
            format!(
                "RECOVERY_REQUIRED: Restore failed ({error}) and OPAL could not read its rollback journal: {read_error}. Keep the library folder unchanged for recovery."
            )
        })?;
        let journal: RestoreJournal = serde_json::from_slice(&journal_bytes).map_err(|journal_error| {
            format!(
                "RECOVERY_REQUIRED: Restore failed ({error}) and OPAL could not decode its rollback journal: {journal_error}. Keep the library folder unchanged for recovery."
            )
        })?;
        let rollback_result = if inject_rollback_failure {
            Err("Injected rollback failure.".to_string())
        } else {
            rollback_restore(roots, &rollback_dir, &journal.original_items)
        };
        if let Err(rollback_error) = rollback_result {
            return Err(format!(
                "RECOVERY_REQUIRED: OPAL could not finish rolling back the restore. Original error: {error}. Recovery error: {rollback_error}. Keep the library folder unchanged for recovery."
            ));
        }
        remove_path(&staging_dir)?;
        remove_path(&rollback_dir)?;
        remove_path(&committed_marker)?;
        remove_path(&roots.root.join(".restore-journal.json"))?;
        return Err(format!("Could not complete the OPAL restore: {error}"));
    }

    if let Err(error) = recover_interrupted_restore(roots) {
        log::warn!("Restored library is active; cleanup will be retried at startup: {error}");
    }
    Ok(())
}

#[tauri::command(rename = "restoreBackup", rename_all = "camelCase")]
fn restore_backup(
    app: tauri::AppHandle,
    state: tauri::State<'_, StartupState>,
    source_path: String,
) -> Result<StorageInfo, String> {
    let _operation = lock_library_operation()?;
    let roots = storage_roots(&app)?;
    let source = PathBuf::from(source_path);
    if let Err(error) = restore_verified_backup(&roots, &source, None) {
        record_diagnostic_error("Library restore failed");
        log::error!("OPAL library restore failed: {error}");
        return Err(error);
    }
    initialise_storage(&roots)?;
    if let Ok(mut storage_error) = state.storage_error.lock() {
        *storage_error = None;
    }
    storage_info_for(&roots)
}

#[tauri::command(rename = "retryStorage", rename_all = "camelCase")]
fn retry_storage(app: tauri::AppHandle) -> Result<StorageInfo, String> {
    let _operation = lock_library_operation()?;
    let roots = storage_roots(&app)?;
    initialise_storage(&roots)?;
    if let Some(state) = app.try_state::<StartupState>() {
        if let Ok(mut storage_error) = state.storage_error.lock() {
            *storage_error = None;
        }
    }
    storage_info_for(&roots)
}

#[tauri::command(rename = "getImportStatus", rename_all = "camelCase")]
fn get_import_status(state: tauri::State<'_, ImportState>, project_id: String) -> ImportStatus {
    state.status(&project_id)
}

#[tauri::command(rename = "getDiagnostics", rename_all = "camelCase")]
fn get_diagnostics(app: tauri::AppHandle) -> Diagnostics {
    let mut diagnostics = Diagnostics {
        app_version: APP_VERSION.to_string(),
        build_commit: BUILD_COMMIT.to_string(),
        platform: std::env::consts::OS.to_string(),
        architecture: std::env::consts::ARCH.to_string(),
        database_version: None,
        schema_version: DATABASE_VERSION,
        database_status: "unavailable".to_string(),
        integrity: "unavailable".to_string(),
        project_count: 0,
        track_count: 0,
        pending_cleanup_count: 0,
        active_import_count: app
            .try_state::<ImportState>()
            .and_then(|state| state.active_projects.lock().ok().map(|set| set.len()))
            .unwrap_or(0),
        recent_errors: recent_diagnostic_errors(),
    };
    let Ok(_operation) = lock_library_operation() else {
        diagnostics.database_status = "busy".to_string();
        return diagnostics;
    };
    let roots = match storage_roots(&app) {
        Ok(roots) => roots,
        Err(_) => {
            record_diagnostic_error("Library storage is unavailable");
            diagnostics.recent_errors = recent_diagnostic_errors();
            return diagnostics;
        }
    };
    match open_database(&roots.db_path) {
        Ok(connection) => {
            diagnostics.database_version = connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .ok();
            diagnostics.database_status = "open".to_string();
            diagnostics.integrity = if database_integrity(&connection).is_ok() {
                "ok".to_string()
            } else {
                record_diagnostic_error("Library integrity check failed");
                "failed".to_string()
            };
            (diagnostics.project_count, diagnostics.track_count) =
                storage_counts(&connection).unwrap_or((0, 0));
            diagnostics.pending_cleanup_count = connection
                .query_row("SELECT COUNT(*) FROM cleanup_queue", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap_or(0)
                .max(0) as usize;
        }
        Err(_) => {
            record_diagnostic_error("Library database could not be opened");
            diagnostics.recent_errors = recent_diagnostic_errors();
        }
    }
    diagnostics.recent_errors = recent_diagnostic_errors();
    diagnostics
}

#[tauri::command(rename = "exportDiagnostics", rename_all = "camelCase")]
fn export_diagnostics(app: tauri::AppHandle, destination: String) -> Result<String, String> {
    let destination = PathBuf::from(destination);
    if !destination.is_absolute() {
        return Err("Choose an absolute destination for the diagnostics file.".to_string());
    }
    let contents = serde_json::to_vec_pretty(&get_diagnostics(app))
        .map_err(|_| "OPAL could not prepare the diagnostics file.".to_string())?;
    fs::write(&destination, contents)
        .map_err(|_| "OPAL could not save the diagnostics file at that location.".to_string())?;
    Ok(destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("OPAL-Diagnostics.json")
        .to_string())
}

fn configure_window(window: &tauri::WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        let _ = window.set_title_bar_style(TitleBarStyle::Overlay);
        let liquid_glass = LiquidGlassOptions::new(NSGlassEffectViewStyle::Clear)
            .radius(26.0)
            .tint_color((62, 42, 103, 42))
            .opaque(false);

        if let Err(error) = apply_liquid_glass(window, liquid_glass) {
            log::info!("Liquid Glass unavailable; using AppKit vibrancy fallback: {error}");
            let _ = apply_vibrancy(
                window,
                NSVisualEffectMaterial::HudWindow,
                Some(NSVisualEffectState::FollowsWindowActiveState),
                Some(26.0),
            );
        } else {
            log::info!("OPAL native Liquid Glass applied");
        }
    }

    #[cfg(target_os = "windows")]
    {
        if apply_mica(window, Some(true)).is_ok() {
            log::info!("OPAL Windows Mica applied");
        } else if apply_acrylic(window, Some((23, 18, 47, 220))).is_ok() {
            log::info!("OPAL Windows Acrylic applied");
        } else {
            let _ = apply_blur(window, Some((23, 18, 47, 220)));
            log::info!("OPAL Windows blur fallback applied");
        }
    }

    #[cfg(target_os = "linux")]
    {
        let _ = window;
        log::info!("OPAL Linux compositor fallback active");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(StartupState::default())
        .manage(ImportState::default())
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("opal-security")
                .on_navigation(|_, url| {
                    let packaged_origin = (url.scheme() == "tauri"
                        && url.host_str() == Some("localhost"))
                        || (matches!(url.scheme(), "http" | "https")
                            && url.host_str() == Some("tauri.localhost"));
                    let development_origin = cfg!(debug_assertions)
                        && matches!(url.scheme(), "http" | "https")
                        && url.host_str() == Some("localhost");
                    packaged_origin || development_origin
                })
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .rotation_strategy(RotationStrategy::KeepSome(5))
                .max_file_size(256 * 1024)
                .build(),
        )
        .setup(|app| {
            let roots = storage_roots(app.handle()).expect("OPAL storage path should be available");
            if let Err(error) = initialise_storage(&roots) {
                record_diagnostic_error("Startup recovery is required");
                log::error!("OPAL startup recovery required: {error}");
                if let Ok(mut storage_error) = app.state::<StartupState>().storage_error.lock() {
                    *storage_error = Some(error);
                }
            }
            let window = app
                .get_webview_window("main")
                .expect("main OPAL window should exist from tauri.conf.json");
            configure_window(&window);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_projects,
            create_project,
            update_project,
            update_track_title,
            reorder_tracks,
            reorder_track_groups,
            reorder_track_versions,
            rename_track_version,
            promote_track_version,
            get_deletion_impact,
            delete_track_version,
            create_moment,
            update_moment,
            update_transition,
            create_capsule,
            get_capsule,
            list_capsules,
            add_capsule_response,
            save_note,
            delete_track,
            delete_project,
            set_project_artwork,
            remove_project_artwork,
            import_audio_files,
            get_storage_info,
            reveal_storage_folder,
            reveal_managed_file,
            get_audio_waveform,
            export_backup,
            restore_backup,
            retry_storage,
            get_import_status,
            get_diagnostics,
            export_diagnostics
        ])
        .run(tauri::generate_context!())
        .expect("error while running OPAL");
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn test_roots(root: &Path) -> StorageRoots {
        StorageRoots {
            root: root.to_path_buf(),
            db_path: root.join("opal.sqlite"),
            audio_dir: root.join("audio"),
            artwork_dir: root.join("artwork"),
            staging_dir: root.join(".staging"),
        }
    }

    #[test]
    fn project_storage_paths_accept_ids_and_reject_path_syntax() {
        let directory = tempdir().expect("temporary project storage root");
        let root = directory.path().join("artwork");
        fs::create_dir_all(&root).expect("artwork root");

        for project_id in ["p", "project_1", "746a57b0-3f50-4a3d-b6e8-48e8dc302d72"] {
            assert_eq!(
                project_storage_dir(&root, project_id).expect("safe project ID"),
                root.join(project_id)
            );
        }

        let too_long = "x".repeat(129);
        for project_id in [
            "",
            ".",
            "..",
            "../outside",
            "/tmp/outside",
            r"..\outside",
            r"C:\Windows\Temp",
            r"\\server\share",
            "name:stream",
            too_long.as_str(),
        ] {
            assert!(
                project_storage_dir(&root, project_id).is_err(),
                "unsafe project ID should be rejected: {project_id:?}"
            );
        }
    }

    #[test]
    fn traversal_project_id_cannot_resolve_to_an_outside_artwork_directory() {
        let directory = tempdir().expect("temporary project storage root");
        let artwork_root = directory.path().join("library/artwork");
        let outside = directory.path().join("outside");
        fs::create_dir_all(&artwork_root).expect("artwork root");
        fs::create_dir_all(&outside).expect("outside directory");
        let marker = outside.join("keep.txt");
        fs::write(&marker, b"keep this file").expect("outside marker");

        assert!(project_storage_dir(&artwork_root, "../outside").is_err());
        assert_eq!(
            fs::read(&marker).expect("outside marker remains"),
            b"keep this file"
        );
    }

    fn seed_full_library(roots: &StorageRoots) {
        fs::create_dir_all(&roots.audio_dir).expect("audio directory");
        fs::create_dir_all(&roots.artwork_dir).expect("artwork directory");
        initialise_database(&roots.db_path).expect("current schema");
        let connection = open_database(&roots.db_path).expect("database");
        connection
            .execute(
                "INSERT INTO projects (id, title, description, artwork_ref, created_at, updated_at) VALUES ('p', 'Fixture Project', 'fixture', 'artwork/p/cover.png', 1, 2)",
                [],
            )
            .expect("project");
        fs::create_dir_all(roots.artwork_dir.join("p")).expect("project artwork directory");
        fs::write(roots.artwork_dir.join("p/cover.png"), b"fixture artwork").expect("artwork");
        for (group_id, title, group_position) in [("g1", "Main", 0), ("g2", "Outro", 1)] {
            connection
                .execute(
                    "INSERT INTO track_groups (id, project_id, title, position, created_at) VALUES (?1, 'p', ?2, ?3, 1)",
                    params![group_id, title, group_position],
                )
                .expect("track group");
        }
        let tracks = [
            ("t1", "g1", "Original", 0, 1),
            ("t2", "g1", "Warm Mix", 1, 0),
            ("t3", "g2", "Original", 0, 1),
        ];
        for (position, (id, group, version, version_position, current)) in tracks.iter().enumerate()
        {
            let relative = format!("audio/p/{id}.wav");
            let path = roots.root.join(&relative);
            fs::create_dir_all(path.parent().expect("audio parent")).expect("audio directory");
            fs::write(&path, format!("fixture audio {id}")).expect("audio file");
            connection
                .execute(
                    "INSERT INTO tracks (id, project_id, group_id, title, position, version_name, version_position, is_current, duration_ms, format, managed_file_ref, source_hash, created_at) VALUES (?1, 'p', ?2, 'Main theme', ?3, ?4, ?5, ?6, 8000, 'WAV', ?7, 'fixture-hash', 1)",
                    params![id, group, position as i64, version, version_position, current, relative],
                )
                .expect("track");
        }
        connection
            .execute(
                "INSERT INTO notes (id, project_id, text, updated_at) VALUES ('np', 'p', 'Project note survives', 1)",
                [],
            )
            .expect("project note");
        connection
            .execute(
                "INSERT INTO notes (id, track_id, text, updated_at) VALUES ('nt', 't1', 'Track note survives', 1)",
                [],
            )
            .expect("track note");
        connection
            .execute(
                "INSERT INTO moments (id, track_id, lineage_id, time_ms, state, text, created_at, updated_at) VALUES ('m1', 't1', 'lineage-1', 1250, 'question', 'Moment survives', 1, 1)",
                [],
            )
            .expect("moment");
        connection
            .execute(
                "INSERT INTO sequence_transitions (id, project_id, from_group_id, to_group_id, gap_ms, note, updated_at) VALUES ('s1', 'p', 'g1', 'g2', 900, 'Transition survives', 1)",
                [],
            )
            .expect("sequence transition");
        connection
            .execute(
                "INSERT INTO listening_capsules (id, project_id, title, message, include_notes, created_at, updated_at) VALUES ('c1', 'p', 'Capsule survives', '', 1, 1, 1)",
                [],
            )
            .expect("capsule");
        for (position, track_id) in ["t1", "t3"].iter().enumerate() {
            connection
                .execute(
                    "INSERT INTO capsule_tracks (capsule_id, track_id, position, created_at) VALUES ('c1', ?1, ?2, 1)",
                    params![track_id, position as i64],
                )
                .expect("capsule track");
        }
        connection
            .execute(
                "INSERT INTO capsule_responses (id, capsule_id, track_id, moment_id, time_ms, state, text, created_at) VALUES ('cr1', 'c1', 't1', 'm1', 1250, 'keep', 'Response survives', 1)",
                [],
            )
            .expect("capsule response");
    }

    fn seed_v3_library(root: &Path) -> PathBuf {
        fs::create_dir_all(root.join("audio/p")).expect("audio directory");
        fs::create_dir_all(root.join("artwork/p")).expect("artwork directory");
        fs::write(root.join("audio/p/t1.wav"), b"legacy audio").expect("audio");
        fs::write(root.join("artwork/p/cover.png"), b"legacy artwork").expect("artwork");
        let database = root.join("opal.sqlite");
        let connection = open_database(&database).expect("database");
        connection
            .execute_batch(
                "
                CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', artwork_ref TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
                CREATE TABLE tracks (id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, title TEXT NOT NULL, position INTEGER NOT NULL, duration_ms INTEGER NOT NULL DEFAULT 0, format TEXT NOT NULL, managed_file_ref TEXT NOT NULL, source_hash TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(project_id, position));
                CREATE TABLE notes (id TEXT PRIMARY KEY NOT NULL, project_id TEXT REFERENCES projects(id) ON DELETE CASCADE, track_id TEXT REFERENCES tracks(id) ON DELETE CASCADE, text TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL);
                CREATE TABLE cleanup_queue (id TEXT PRIMARY KEY NOT NULL, managed_path TEXT NOT NULL UNIQUE, queued_at INTEGER NOT NULL);
                INSERT INTO projects VALUES ('p', 'Legacy project', '', 'artwork/p/cover.png', 1, 2);
                INSERT INTO tracks VALUES ('t1', 'p', 'Legacy track', 0, 8000, 'WAV', 'audio/p/t1.wav', 'legacy-hash', 1);
                INSERT INTO notes VALUES ('n1', 'p', NULL, 'Legacy note', 1);
                PRAGMA user_version = 3;
                ",
            )
            .expect("v3 schema and fixture rows");
        database
    }

    #[test]
    fn database_migration_is_idempotent() {
        let directory = tempdir().expect("temporary database directory");
        let database = directory.path().join("opal.sqlite");
        initialise_database(&database).expect("first migration");
        initialise_database(&database).expect("second migration");
        assert_eq!(
            fs::read_dir(directory.path().join("backups"))
                .map(|entries| entries.count())
                .unwrap_or(0),
            0,
            "current schema startup must not create migration backups"
        );
        let connection = open_database(&database).expect("open migrated database");
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("version");
        assert_eq!(version, 7);
        connection.execute("INSERT INTO projects (id, title, created_at, updated_at) VALUES ('p', 'Project', 1, 1)", []).expect("project insert");
        connection.execute("INSERT INTO tracks (id, project_id, title, position, format, managed_file_ref, source_hash, created_at) VALUES ('t', 'p', 'Track', 0, 'WAV', 'audio/p/t.wav', 'hash', 1)", []).expect("track insert");
        let title: String = connection
            .query_row("SELECT title FROM tracks WHERE id = 't'", [], |row| {
                row.get(0)
            })
            .expect("track title");
        assert_eq!(title, "Track");
        let version: (Option<String>, String, i64) = connection
            .query_row(
                "SELECT group_id, version_name, is_current FROM tracks WHERE id = 't'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("track version metadata");
        assert_eq!(version, (None, "Original".to_string(), 1));
        let group_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM track_groups WHERE project_id = 'p'",
                [],
                |row| row.get(0),
            )
            .expect("track group count");
        assert_eq!(group_count, 0);
        connection
            .execute(
                "INSERT INTO moments (id, track_id, lineage_id, time_ms, state, text, created_at, updated_at) VALUES ('m', 't', 'lineage', 1250, 'question', 'Check the vocal entrance', 3, 3)",
                [],
            )
            .expect("moment insert");
        let moment: (i64, String, String) = connection
            .query_row(
                "SELECT time_ms, state, text FROM moments WHERE id = 'm'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("moment read");
        assert_eq!(
            moment,
            (
                1250,
                "question".to_string(),
                "Check the vocal entrance".to_string()
            )
        );
        let transition_table: String = connection
            .query_row(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sequence_transitions'",
                [],
                |row| row.get(0),
            )
            .expect("sequence transition table");
        assert_eq!(transition_table, "sequence_transitions");
        connection
            .execute(
                "INSERT INTO notes (id, project_id, text, updated_at) VALUES ('n', 'p', 'A note', 2)",
                [],
            )
            .expect("note insert");
        let note: String = connection
            .query_row("SELECT text FROM notes WHERE project_id = 'p'", [], |row| {
                row.get(0)
            })
            .expect("note text");
        assert_eq!(note, "A note");
    }

    #[test]
    fn newer_database_requires_compatible_opal_without_mutating_library() {
        let directory = tempdir().expect("temporary database directory");
        let database = directory.path().join("opal.sqlite");
        initialise_database(&database).expect("current schema");
        let connection = open_database(&database).expect("database");
        connection
            .execute(
                "INSERT INTO projects (id, title, created_at, updated_at) VALUES ('p', 'Keep me', 1, 1)",
                [],
            )
            .expect("project fixture");
        connection
            .pragma_update(None, "user_version", DATABASE_VERSION + 1)
            .expect("newer schema version");
        drop(connection);

        let error = initialise_database(&database).expect_err("newer schema is rejected");
        assert!(error.starts_with("COMPATIBILITY_REQUIRED:"));
        let unchanged = open_database(&database).expect("database remains readable");
        let version: i64 = unchanged
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("future schema version remains");
        let title: String = unchanged
            .query_row("SELECT title FROM projects WHERE id = 'p'", [], |row| {
                row.get(0)
            })
            .expect("project remains");
        assert_eq!(version, DATABASE_VERSION + 1);
        assert_eq!(title, "Keep me");
        assert_eq!(
            fs::read_dir(directory.path().join("backups"))
                .map(|entries| entries.count())
                .unwrap_or(0),
            0
        );
    }

    #[test]
    fn supported_migration_chains_keep_one_verified_pre_migration_backup() {
        for source_version in 3..=6 {
            let directory = tempdir().expect("temporary migration library");
            let database = if source_version == 3 {
                seed_v3_library(directory.path())
            } else {
                let roots = test_roots(directory.path());
                seed_full_library(&roots);
                let connection = open_database(&roots.db_path).expect("fixture database");
                match source_version {
                    4 => connection
                        .execute_batch(
                            "DROP TABLE capsule_responses; DROP TABLE capsule_tracks; DROP TABLE listening_capsules; DROP TABLE sequence_transitions; DROP TABLE moments;",
                        )
                        .expect("downgrade fixture to v4"),
                    5 => connection
                        .execute_batch(
                            "DROP TABLE capsule_responses; DROP TABLE capsule_tracks; DROP TABLE listening_capsules; DROP TABLE sequence_transitions;",
                        )
                        .expect("downgrade fixture to v5"),
                    6 => connection
                        .execute_batch(
                            "DROP TABLE capsule_responses; DROP TABLE capsule_tracks; DROP TABLE listening_capsules;",
                        )
                        .expect("downgrade fixture to v6"),
                    _ => unreachable!(),
                }
                connection
                    .pragma_update(None, "user_version", source_version)
                    .expect("source schema version");
                drop(connection);
                roots.db_path
            };

            initialise_database(&database).expect("supported migration chain");
            let migrated = open_database(&database).expect("migrated database");
            let version: i64 = migrated
                .query_row("PRAGMA user_version", [], |row| row.get(0))
                .expect("migrated version");
            assert_eq!(version, DATABASE_VERSION);
            database_integrity(&migrated).expect("migrated integrity");
            let project_note: String = migrated
                .query_row("SELECT text FROM notes WHERE project_id = 'p'", [], |row| {
                    row.get(0)
                })
                .expect("project note preserved");
            assert_eq!(
                project_note,
                if source_version == 3 {
                    "Legacy note"
                } else {
                    "Project note survives"
                }
            );
            let track_count: i64 = migrated
                .query_row(
                    "SELECT COUNT(*) FROM tracks WHERE project_id = 'p'",
                    [],
                    |row| row.get(0),
                )
                .expect("track count");
            assert_eq!(track_count, if source_version == 3 { 1 } else { 3 });
            if source_version >= 4 {
                let versions: i64 = migrated
                    .query_row(
                        "SELECT COUNT(*) FROM tracks WHERE version_name = 'Warm Mix'",
                        [],
                        |row| row.get(0),
                    )
                    .expect("version count");
                assert_eq!(
                    versions, 1,
                    "version rows survive v{source_version} migration"
                );
            }
            let moments: i64 = migrated
                .query_row("SELECT COUNT(*) FROM moments", [], |row| row.get(0))
                .expect("moment count");
            assert_eq!(moments, if source_version >= 5 { 1 } else { 0 });
            let transitions: i64 = migrated
                .query_row("SELECT COUNT(*) FROM sequence_transitions", [], |row| {
                    row.get(0)
                })
                .expect("transition count");
            assert_eq!(transitions, if source_version >= 6 { 1 } else { 0 });
            let capsules: i64 = migrated
                .query_row("SELECT COUNT(*) FROM listening_capsules", [], |row| {
                    row.get(0)
                })
                .expect("capsule count");
            assert_eq!(
                capsules, 0,
                "capsules are introduced in v7, after source v{source_version}"
            );
            drop(migrated);

            let backup_entries = fs::read_dir(directory.path().join("backups"))
                .expect("migration backup folder")
                .collect::<Result<Vec<_>, _>>()
                .expect("backup entries");
            assert_eq!(
                backup_entries.len(),
                1,
                "one backup for the v{source_version} chain"
            );
            let backup = open_database(&backup_entries[0].path()).expect("pre-migration backup");
            database_integrity(&backup).expect("backup integrity");
            let backup_version: i64 = backup
                .query_row("PRAGMA user_version", [], |row| row.get(0))
                .expect("backup version");
            assert_eq!(backup_version, source_version);
        }
    }

    #[test]
    fn file_hash_is_stable_and_duration_is_readable() {
        let directory = tempdir().expect("temporary file directory");
        let first = directory.path().join("space name — one.wav");
        let second = directory.path().join("unicode-é.wav");
        fs::write(&first, b"OPAL audio bytes").expect("first file");
        fs::write(&second, b"OPAL audio bytes").expect("second file");
        assert_eq!(
            hash_file(&first).expect("first hash"),
            hash_file(&second).expect("second hash")
        );
        assert_eq!(format_track_duration(185_000), "3:05");
        assert_eq!(fallback_title(&first), "space name — one");
    }

    #[test]
    fn notes_persist_for_project_and_track_contexts() {
        let directory = tempdir().expect("temporary database directory");
        let database = directory.path().join("opal.sqlite");
        initialise_database(&database).expect("migration");
        let roots = StorageRoots {
            root: directory.path().to_path_buf(),
            db_path: database.clone(),
            audio_dir: directory.path().join("audio"),
            artwork_dir: directory.path().join("artwork"),
            staging_dir: directory.path().join(".staging"),
        };
        let connection = open_database(&database).expect("database");
        connection
            .execute(
                "INSERT INTO projects (id, title, created_at, updated_at) VALUES ('p', 'Project', 1, 1)",
                [],
            )
            .expect("project insert");
        connection
            .execute(
                "INSERT INTO tracks (id, project_id, title, position, format, managed_file_ref, source_hash, created_at) VALUES ('t', 'p', 'Track', 0, 'WAV', 'audio/p/t.wav', 'hash', 1)",
                [],
            )
            .expect("track insert");
        connection
            .execute(
                "INSERT INTO notes (id, project_id, text, updated_at) VALUES ('pn', 'p', 'Project thought', 2)",
                [],
            )
            .expect("project note insert");
        connection
            .execute(
                "INSERT INTO notes (id, track_id, text, updated_at) VALUES ('tn', 't', 'Track thought', 3)",
                [],
            )
            .expect("track note insert");
        let project = load_project(&connection, &roots, "p").expect("load project");
        assert_eq!(
            project.project_note.expect("project note").text,
            "Project thought"
        );
        assert_eq!(
            project.tracks[0].note.as_ref().expect("track note").text,
            "Track thought"
        );
    }

    #[test]
    fn managed_audio_stays_until_the_last_reference_is_removed() {
        let directory = tempdir().expect("temporary database directory");
        let database = directory.path().join("opal.sqlite");
        initialise_database(&database).expect("migration");
        let roots = StorageRoots {
            root: directory.path().to_path_buf(),
            db_path: database.clone(),
            audio_dir: directory.path().join("audio"),
            artwork_dir: directory.path().join("artwork"),
            staging_dir: directory.path().join(".staging"),
        };
        let managed_file_ref = "audio/p/shared.wav";
        let managed_path = roots.root.join(managed_file_ref);
        fs::create_dir_all(managed_path.parent().expect("managed folder")).expect("audio folder");
        fs::write(&managed_path, b"managed audio").expect("managed file");
        let connection = open_database(&database).expect("database");
        connection
            .execute(
                "INSERT INTO projects (id, title, created_at, updated_at) VALUES ('p', 'Project', 1, 1)",
                [],
            )
            .expect("project insert");
        for (id, position) in [("one", 0), ("two", 1)] {
            connection
                .execute(
                    "INSERT INTO tracks (id, project_id, title, position, format, managed_file_ref, source_hash, created_at) VALUES (?1, 'p', ?1, ?2, 'WAV', ?3, ?1, 1)",
                    params![id, position, managed_file_ref],
                )
                .expect("track insert");
        }
        connection
            .execute("DELETE FROM tracks WHERE id = 'one'", [])
            .expect("first delete");
        remove_managed_file_if_unreferenced(&connection, &roots, managed_file_ref)
            .expect("first cleanup");
        assert!(managed_path.is_file());
        connection
            .execute("DELETE FROM tracks WHERE id = 'two'", [])
            .expect("second delete");
        remove_managed_file_if_unreferenced(&connection, &roots, managed_file_ref)
            .expect("second cleanup");
        assert!(!managed_path.exists());
    }

    #[test]
    fn v2_migration_creates_a_recoverable_backup_and_cleanup_queue() {
        let directory = tempdir().expect("temporary migration directory");
        let database = directory.path().join("opal.sqlite");
        let connection = open_database(&database).expect("database");
        connection
            .execute_batch(
                "
                CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', artwork_ref TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
                CREATE TABLE tracks (id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, title TEXT NOT NULL, position INTEGER NOT NULL, duration_ms INTEGER NOT NULL DEFAULT 0, format TEXT NOT NULL, managed_file_ref TEXT NOT NULL, source_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
                CREATE TABLE notes (id TEXT PRIMARY KEY NOT NULL, project_id TEXT, track_id TEXT, text TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL);
                PRAGMA user_version = 2;
                ",
            )
            .expect("v2 schema");
        drop(connection);

        initialise_database(&database).expect("v2 migration");
        let migrated = open_database(&database).expect("migrated database");
        let version: i64 = migrated
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("version");
        assert_eq!(version, 7);
        let cleanup_table: String = migrated
            .query_row(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cleanup_queue'",
                [],
                |row| row.get(0),
            )
            .expect("cleanup queue");
        assert_eq!(cleanup_table, "cleanup_queue");
        assert_eq!(
            fs::read_dir(directory.path().join("backups"))
                .expect("backups")
                .count(),
            1
        );
    }

    #[test]
    fn sequence_transitions_load_with_their_project() {
        let directory = tempdir().expect("temporary sequence directory");
        let database = directory.path().join("opal.sqlite");
        initialise_database(&database).expect("migration");
        let roots = StorageRoots {
            root: directory.path().to_path_buf(),
            db_path: database.clone(),
            audio_dir: directory.path().join("audio"),
            artwork_dir: directory.path().join("artwork"),
            staging_dir: directory.path().join(".staging"),
        };
        let connection = open_database(&database).expect("database");
        connection
            .execute(
                "INSERT INTO projects (id, title, created_at, updated_at) VALUES ('p', 'Sequence', 1, 1)",
                [],
            )
            .expect("project insert");
        for (id, title, position) in [("g1", "Intro", 0), ("g2", "Resolve", 1)] {
            connection
                .execute(
                    "INSERT INTO track_groups (id, project_id, title, position, created_at) VALUES (?1, 'p', ?2, ?3, 1)",
                    params![id, title, position],
                )
                .expect("track group insert");
        }
        for (id, group_id, title, position) in
            [("t1", "g1", "Intro", 0), ("t2", "g2", "Resolve", 1)]
        {
            connection
                .execute(
                    "INSERT INTO tracks (id, project_id, group_id, title, position, version_name, version_position, is_current, format, managed_file_ref, source_hash, created_at) VALUES (?1, 'p', ?2, ?3, ?4, 'Original', 0, 1, 'WAV', ?5, ?1, 1)",
                    params![id, group_id, title, position, format!("audio/p/{id}.wav")],
                )
                .expect("track insert");
        }
        connection
            .execute(
                "INSERT INTO sequence_transitions (id, project_id, from_group_id, to_group_id, gap_ms, note, updated_at) VALUES ('transition', 'p', 'g1', 'g2', 1800, 'Let the reverb breathe', 2)",
                [],
            )
            .expect("transition insert");

        let project = load_project(&connection, &roots, "p").expect("load project");
        assert_eq!(project.transitions.len(), 1);
        assert_eq!(project.transitions[0].from_group_id, "g1");
        assert_eq!(project.transitions[0].to_group_id, "g2");
        assert_eq!(project.transitions[0].gap_ms, 1800);
        assert_eq!(project.transitions[0].note, "Let the reverb breathe");
    }

    #[test]
    fn unresolved_moments_are_carried_to_the_next_version_with_lineage() {
        let directory = tempdir().expect("temporary moments directory");
        let database = directory.path().join("opal.sqlite");
        initialise_database(&database).expect("migration");
        let connection = open_database(&database).expect("database");
        connection
            .execute(
                "INSERT INTO projects (id, title, created_at, updated_at) VALUES ('p', 'Project', 1, 1)",
                [],
            )
            .expect("project insert");
        connection
            .execute(
                "INSERT INTO tracks (id, project_id, title, position, version_name, version_position, is_current, format, managed_file_ref, source_hash, created_at) VALUES ('source', 'p', 'Track', 0, 'Original', 0, 0, 'WAV', 'audio/p/source.wav', 'source-hash', 1)",
                [],
            )
            .expect("source track insert");
        connection
            .execute(
                "INSERT INTO tracks (id, project_id, title, position, version_name, version_position, is_current, format, managed_file_ref, source_hash, created_at) VALUES ('target', 'p', 'Track', 1, 'Bounce 2', 1, 1, 'WAV', 'audio/p/target.wav', 'target-hash', 1)",
                [],
            )
            .expect("target track insert");
        connection
            .execute(
                "INSERT INTO moments (id, track_id, lineage_id, time_ms, state, text, is_resolved, created_at, updated_at) VALUES ('open', 'source', 'lineage-open', 1850, 'change', 'Tighten the snare', 0, 2, 2)",
                [],
            )
            .expect("open moment insert");
        connection
            .execute(
                "INSERT INTO moments (id, track_id, lineage_id, time_ms, state, text, is_resolved, created_at, updated_at) VALUES ('resolved', 'source', 'lineage-resolved', 4200, 'keep', 'Approved texture', 1, 2, 2)",
                [],
            )
            .expect("resolved moment insert");

        carry_unresolved_moments(&connection, "source", "target").expect("carry moments");

        let carried: (String, i64, String, String, i64, Option<String>) = connection
            .query_row(
                "SELECT lineage_id, time_ms, state, text, is_resolved, parent_id FROM moments WHERE track_id = 'target'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
            )
            .expect("carried moment");
        assert_eq!(
            carried,
            (
                "lineage-open".to_string(),
                1850,
                "change".to_string(),
                "Tighten the snare".to_string(),
                0,
                Some("open".to_string())
            )
        );
        let carried_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM moments WHERE track_id = 'target'",
                [],
                |row| row.get(0),
            )
            .expect("carried moment count");
        assert_eq!(carried_count, 1);
    }

    #[test]
    fn project_without_artwork_is_deletable_and_returns_an_empty_artwork_ref() {
        let directory = tempdir().expect("temporary no-artwork directory");
        let database = directory.path().join("opal.sqlite");
        initialise_database(&database).expect("migration");
        let connection = open_database(&database).expect("database");
        connection
            .execute(
                "INSERT INTO projects (id, title, created_at, updated_at) VALUES ('p', 'No artwork', 1, 1)",
                [],
            )
            .expect("project insert");

        assert_eq!(
            project_artwork_ref(&connection, "p").expect("artwork lookup"),
            Some(None)
        );
        assert_eq!(
            project_artwork_ref(&connection, "missing").expect("missing lookup"),
            None
        );
    }

    #[test]
    fn startup_recovery_removes_abandoned_staging_and_keeps_completed_audio() {
        let directory = tempdir().expect("temporary staging directory");
        let roots = StorageRoots {
            root: directory.path().to_path_buf(),
            db_path: directory.path().join("opal.sqlite"),
            audio_dir: directory.path().join("audio"),
            artwork_dir: directory.path().join("artwork"),
            staging_dir: directory.path().join(".staging"),
        };
        let completed = roots.audio_dir.join("project/completed.wav");
        let abandoned = roots.staging_dir.join("audio-interrupted/partial.wav");
        fs::create_dir_all(completed.parent().expect("audio parent")).expect("audio folder");
        fs::create_dir_all(abandoned.parent().expect("staging parent")).expect("staging folder");
        fs::write(&completed, b"committed audio").expect("completed file");
        fs::write(&abandoned, b"partial audio").expect("partial file");

        initialise_storage(&roots).expect("startup recovery");

        assert!(completed.is_file());
        assert!(!abandoned.exists());
        assert!(roots.staging_dir.is_dir());
    }

    #[test]
    fn pending_cleanup_removes_only_unreferenced_managed_files() {
        let directory = tempdir().expect("temporary cleanup directory");
        let database = directory.path().join("opal.sqlite");
        initialise_database(&database).expect("migration");
        let roots = StorageRoots {
            root: directory.path().to_path_buf(),
            db_path: database.clone(),
            audio_dir: directory.path().join("audio"),
            artwork_dir: directory.path().join("artwork"),
            staging_dir: directory.path().join(".staging"),
        };
        let managed_file = roots.audio_dir.join("p/orphan.wav");
        fs::create_dir_all(managed_file.parent().expect("audio folder")).expect("audio folder");
        fs::write(&managed_file, b"orphan").expect("managed file");
        let connection = open_database(&database).expect("database");
        queue_managed_cleanup(&connection, "audio/p/orphan.wav").expect("queue cleanup");
        drop(connection);
        retry_pending_cleanup(&roots).expect("retry cleanup");
        assert!(!managed_file.exists());
    }

    #[test]
    fn imports_are_serialized_per_project() {
        let state = ImportState::default();
        let guard = state.begin("project").expect("first import");
        assert!(state.begin("project").is_err());
        drop(guard);
        assert!(state.begin("project").is_ok());
    }

    #[test]
    fn backup_manifest_must_match_the_database() {
        let directory = tempdir().expect("temporary backup directory");
        let database = directory.path().join("opal.sqlite");
        initialise_database(&database).expect("migration");
        let backup = directory.path().join("backup");
        fs::create_dir_all(backup.join("audio")).expect("audio folder");
        fs::create_dir_all(backup.join("artwork")).expect("artwork folder");
        fs::copy(&database, backup.join("opal.sqlite")).expect("database copy");
        let manifest = BackupManifest {
            format_version: 1,
            app_version: APP_VERSION.to_string(),
            exported_at: 1,
            database: "opal.sqlite".to_string(),
            audio_directory: "audio".to_string(),
            artwork_directory: "artwork".to_string(),
            project_count: 0,
            track_count: 0,
            assets: Vec::new(),
        };
        fs::write(
            backup.join("manifest.json"),
            serde_json::to_vec(&manifest).expect("manifest json"),
        )
        .expect("manifest");
        validate_backup(&backup).expect("valid backup");
        let invalid_manifest = BackupManifest {
            project_count: 1,
            ..manifest
        };
        fs::write(
            backup.join("manifest.json"),
            serde_json::to_vec(&invalid_manifest).expect("manifest json"),
        )
        .expect("manifest");
        assert!(validate_backup(&backup).is_err());
    }

    #[test]
    fn backup_rejects_project_ids_that_cannot_name_managed_storage() {
        let directory = tempdir().expect("temporary backup directory");
        let backup = directory.path().join("backup");
        fs::create_dir_all(backup.join("audio")).expect("audio folder");
        fs::create_dir_all(backup.join("artwork")).expect("artwork folder");
        let database = backup.join("opal.sqlite");
        initialise_database(&database).expect("migration");
        let connection = open_database(&database).expect("database");
        connection
            .execute(
                "INSERT INTO projects (id, title, created_at, updated_at) VALUES (?1, 'Traversal', 1, 1)",
                params!["../outside"],
            )
            .expect("malicious project fixture");
        drop(connection);
        let manifest = BackupManifest {
            format_version: 1,
            app_version: APP_VERSION.to_string(),
            exported_at: 1,
            database: "opal.sqlite".to_string(),
            audio_directory: "audio".to_string(),
            artwork_directory: "artwork".to_string(),
            project_count: 1,
            track_count: 0,
            assets: Vec::new(),
        };
        fs::write(
            backup.join("manifest.json"),
            serde_json::to_vec(&manifest).expect("manifest json"),
        )
        .expect("manifest");

        assert!(validate_backup(&backup).is_err());
    }

    #[test]
    fn verified_backup_hashes_assets_and_rejects_missing_or_changed_files() {
        let library = tempdir().expect("temporary source library");
        let roots = test_roots(library.path());
        seed_full_library(&roots);
        let destination = tempdir().expect("backup destination");
        let backup_path =
            create_verified_backup(&roots, destination.path()).expect("verified backup");
        let manifest = validate_backup(&backup_path).expect("backup validates");
        assert_eq!(manifest.assets.len(), 4);
        let audio_path = backup_path.join("audio/p/t1.wav");
        fs::write(&audio_path, b"changed backup audio").expect("alter backup audio");
        assert!(validate_backup(&backup_path).is_err());
        fs::write(&audio_path, b"fixture audio t1").expect("restore audio bytes");
        fs::remove_file(backup_path.join("artwork/p/cover.png"))
            .expect("remove referenced artwork");
        assert!(validate_backup(&backup_path).is_err());
    }

    #[test]
    fn backup_destinations_cannot_be_nested_in_managed_storage() {
        let live = tempdir().expect("temporary live library");
        let roots = test_roots(live.path());
        fs::create_dir_all(&roots.root.join("backups/export-here"))
            .expect("nested destination folder");
        let error = canonical_backup_destination(&roots, &roots.root.join("backups/export-here"))
            .expect_err("nested backup destinations are rejected");
        assert!(error.contains("outside OPAL managed storage"));

        let external = tempdir().expect("external destination");
        assert_eq!(
            canonical_backup_destination(&roots, external.path()).expect("external path accepted"),
            external
                .path()
                .canonicalize()
                .expect("canonical destination")
        );
    }

    #[test]
    fn invalid_backup_and_missing_assets_never_change_the_live_library() {
        let live = tempdir().expect("temporary live library");
        let roots = test_roots(live.path());
        seed_full_library(&roots);
        let backup_root = tempdir().expect("temporary backup folder");
        let valid_backup = create_verified_backup(&roots, backup_root.path()).expect("backup");
        let missing_asset = tempdir().expect("corrupt backup folder");
        copy_directory(
            &valid_backup.join("audio"),
            &missing_asset.path().join("audio"),
        )
        .expect("copy audio");
        copy_directory(
            &valid_backup.join("artwork"),
            &missing_asset.path().join("artwork"),
        )
        .expect("copy artwork");
        fs::copy(
            valid_backup.join("opal.sqlite"),
            missing_asset.path().join("opal.sqlite"),
        )
        .expect("copy database");
        fs::copy(
            valid_backup.join("manifest.json"),
            missing_asset.path().join("manifest.json"),
        )
        .expect("copy manifest");
        fs::remove_file(missing_asset.path().join("audio/p/t1.wav"))
            .expect("remove referenced audio");

        assert!(restore_verified_backup(&roots, missing_asset.path(), None).is_err());
        let connection = open_database(&roots.db_path).expect("unchanged live database");
        let title: String = connection
            .query_row("SELECT title FROM projects WHERE id = 'p'", [], |row| {
                row.get(0)
            })
            .expect("live project remains");
        assert_eq!(title, "Fixture Project");
        assert_eq!(
            fs::read(roots.audio_dir.join("p/t1.wav")).expect("live audio"),
            b"fixture audio t1"
        );
        assert_eq!(
            fs::read_dir(roots.root.join("backups"))
                .map(|entries| entries.count())
                .unwrap_or(0),
            0
        );
    }

    #[test]
    fn injected_backup_copy_failures_never_finalize_a_partial_export() {
        let live = tempdir().expect("temporary live library");
        let roots = test_roots(live.path());
        seed_full_library(&roots);
        let destination = tempdir().expect("temporary export destination");

        for failure in [
            BackupFailurePoint::BeforeAudioCopy,
            BackupFailurePoint::AfterAudioCopy,
        ] {
            assert!(
                create_verified_backup_with_failure(&roots, destination.path(), Some(failure),)
                    .is_err()
            );
            assert_eq!(
                fs::read_dir(destination.path())
                    .expect("export folder")
                    .count(),
                0,
                "failed export must remove its incomplete staging directory"
            );
        }

        let connection = open_database(&roots.db_path).expect("live database remains");
        database_integrity(&connection).expect("live database integrity");
        let title: String = connection
            .query_row("SELECT title FROM projects WHERE id = 'p'", [], |row| {
                row.get(0)
            })
            .expect("live project remains");
        assert_eq!(title, "Fixture Project");
        assert_eq!(
            fs::read(roots.audio_dir.join("p/t1.wav")).expect("live audio remains"),
            b"fixture audio t1"
        );
    }

    #[test]
    fn restore_copy_failures_before_and_after_prebackup_leave_live_library_recoverable() {
        let source = tempdir().expect("source library");
        let source_roots = test_roots(source.path());
        seed_full_library(&source_roots);
        let destination = tempdir().expect("source backup destination");
        let backup =
            create_verified_backup(&source_roots, destination.path()).expect("source backup");

        let live = tempdir().expect("live library");
        let live_roots = test_roots(live.path());
        seed_full_library(&live_roots);
        for (failure, expected_prebackups) in [
            (RestoreFailurePoint::DuringStagingCopy, 0),
            (RestoreFailurePoint::AfterPreRestoreBackup, 1),
        ] {
            assert!(restore_verified_backup(&live_roots, &backup, Some(failure)).is_err());
            let connection = open_database(&live_roots.db_path).expect("live database remains");
            database_integrity(&connection).expect("live database integrity");
            let title: String = connection
                .query_row("SELECT title FROM projects WHERE id = 'p'", [], |row| {
                    row.get(0)
                })
                .expect("live project remains");
            assert_eq!(title, "Fixture Project");
            assert_eq!(
                fs::read(live_roots.audio_dir.join("p/t1.wav")).expect("live audio remains"),
                b"fixture audio t1"
            );
            assert!(!live_roots.root.join(".restore-journal.json").exists());
            assert_eq!(
                fs::read_dir(live_roots.root.join("backups"))
                    .map(|entries| entries.count())
                    .unwrap_or(0),
                expected_prebackups
            );
        }
    }

    #[test]
    fn failed_import_copy_and_database_commit_leave_library_unchanged() {
        let live = tempdir().expect("temporary live library");
        let roots = test_roots(live.path());
        seed_full_library(&roots);
        let source_directory = tempdir().expect("source audio folder");
        let source = source_directory.path().join("new-version.wav");
        fs::write(&source, b"new imported audio").expect("source audio");
        fs::create_dir_all(&roots.staging_dir).expect("staging folder");
        let mut connection = open_database(&roots.db_path).expect("database");
        let before_tracks: i64 = connection
            .query_row("SELECT COUNT(*) FROM tracks", [], |row| row.get(0))
            .expect("track count");
        let before_groups: i64 = connection
            .query_row("SELECT COUNT(*) FROM track_groups", [], |row| row.get(0))
            .expect("group count");

        let rejected_stage = roots.staging_dir.join("rejected.wav");
        assert!(copy_import_to_staging(
            &source,
            &rejected_stage,
            Some(ImportFailurePoint::DuringStagingCopy),
        )
        .is_err());
        assert!(!rejected_stage.exists());

        for failure in [
            ImportFailurePoint::AfterGroupCreated,
            ImportFailurePoint::AfterTrackInserted,
        ] {
            let track_id = Uuid::new_v4().to_string();
            let staged = roots.staging_dir.join(format!("{track_id}.wav"));
            copy_import_to_staging(&source, &staged, None).expect("stage import source");
            let managed_ref = format!("audio/p/{track_id}.wav");
            let managed_path = roots.root.join(&managed_ref);
            let track = TrackDto {
                id: track_id.clone(),
                project_id: "p".to_string(),
                group_id: track_id.clone(),
                title: "New version".to_string(),
                source_title: "New version".to_string(),
                position: 3,
                version_name: "Original".to_string(),
                version_position: 0,
                is_current: true,
                version_count: 1,
                duration_ms: 1000,
                duration: "0:01".to_string(),
                format: "WAV".to_string(),
                managed_file_ref: managed_ref,
                managed_file_path: Some(managed_path.to_string_lossy().into_owned()),
                note: None,
                moments: Vec::new(),
            };
            assert!(commit_imported_track(
                &mut connection,
                &staged,
                &managed_path,
                Some((track_id.as_str(), "New version", 2)),
                &track,
                3,
                "new-audio-hash",
                None,
                Some(failure),
            )
            .is_err());
            assert!(!managed_path.exists());
            assert!(!staged.exists());
            let track_count: i64 = connection
                .query_row("SELECT COUNT(*) FROM tracks", [], |row| row.get(0))
                .expect("track count after failed import");
            let group_count: i64 = connection
                .query_row("SELECT COUNT(*) FROM track_groups", [], |row| row.get(0))
                .expect("group count after failed import");
            assert_eq!(track_count, before_tracks);
            assert_eq!(group_count, before_groups);
        }
        assert_eq!(
            fs::read(&source).expect("original source preserved"),
            b"new imported audio"
        );
        assert_eq!(
            fs::read(roots.audio_dir.join("p/t1.wav")).expect("existing managed audio"),
            b"fixture audio t1"
        );
    }

    #[test]
    fn capsule_summaries_expose_password_expiry_and_missing_selected_versions() {
        let live = tempdir().expect("temporary library");
        let roots = test_roots(live.path());
        seed_full_library(&roots);
        let connection = open_database(&roots.db_path).expect("database");
        connection
            .execute(
                "UPDATE listening_capsules SET password_hash = ?1, expires_at = ?2 WHERE id = 'c1'",
                params![capsule_password_hash("c1", "local-only"), now_ms() - 1],
            )
            .expect("protect and expire capsule");
        connection
            .execute_batch("PRAGMA foreign_keys = OFF;")
            .expect("disable fixture constraints");
        connection
            .execute(
                "INSERT INTO capsule_tracks (capsule_id, track_id, position, created_at) VALUES ('c1', 'missing-track', 2, 1)",
                [],
            )
            .expect("simulate a capsule with a missing selected version");

        let summaries = list_capsule_summaries(&connection, "p").expect("capsule summaries");

        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].id, "c1");
        assert_eq!(summaries[0].track_count, 3);
        assert_eq!(summaries[0].missing_version_count, 1);
        assert!(summaries[0].has_password);
        assert!(summaries[0].is_expired);
    }

    #[test]
    fn deleting_a_version_removes_its_capsule_and_responses_and_reports_the_impact() {
        let live = tempdir().expect("temporary live library");
        let roots = test_roots(live.path());
        seed_full_library(&roots);
        let mut connection = open_database(&roots.db_path).expect("database");
        assert_eq!(
            capsule_deletion_impact(&connection, "p", Some("t1")).expect("version impact"),
            DeletionImpact {
                affected_capsules: 1,
                affected_responses: 1,
            }
        );
        let transaction = connection.transaction().expect("deletion transaction");
        delete_capsules_referencing_track(&transaction, "t1").expect("delete affected Capsule");
        transaction
            .execute("DELETE FROM tracks WHERE id = 't1'", [])
            .expect("delete version");
        transaction.commit().expect("commit version deletion");
        let capsule_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM listening_capsules", [], |row| {
                row.get(0)
            })
            .expect("capsule count");
        let response_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM capsule_responses", [], |row| {
                row.get(0)
            })
            .expect("response count");
        let remaining_versions: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM tracks WHERE id IN ('t2', 't3')",
                [],
                |row| row.get(0),
            )
            .expect("unrelated tracks remain");
        assert_eq!(capsule_count, 0);
        assert_eq!(response_count, 0);
        assert_eq!(remaining_versions, 2);
    }

    #[test]
    fn deleting_a_project_reports_and_cascades_all_capsules_and_responses() {
        let live = tempdir().expect("temporary live library");
        let roots = test_roots(live.path());
        seed_full_library(&roots);
        let connection = open_database(&roots.db_path).expect("database");
        assert_eq!(
            capsule_deletion_impact(&connection, "p", None).expect("project impact"),
            DeletionImpact {
                affected_capsules: 1,
                affected_responses: 1,
            }
        );
        connection
            .execute("DELETE FROM projects WHERE id = 'p'", [])
            .expect("delete project and cascade Capsule data");
        let capsule_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM listening_capsules", [], |row| {
                row.get(0)
            })
            .expect("capsule count");
        let response_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM capsule_responses", [], |row| {
                row.get(0)
            })
            .expect("response count");
        assert_eq!(capsule_count, 0);
        assert_eq!(response_count, 0);
    }

    #[test]
    fn restore_failure_after_prebackup_restores_database_and_managed_assets() {
        let source = tempdir().expect("source library");
        let source_roots = test_roots(source.path());
        seed_full_library(&source_roots);
        let source_connection = open_database(&source_roots.db_path).expect("source database");
        source_connection
            .execute(
                "UPDATE projects SET title = 'Restored project' WHERE id = 'p'",
                [],
            )
            .expect("change restore source");
        drop(source_connection);
        let backup_destination = tempdir().expect("backup destination");
        let backup = create_verified_backup(&source_roots, backup_destination.path())
            .expect("source backup");

        let live = tempdir().expect("live library");
        let live_roots = test_roots(live.path());
        seed_full_library(&live_roots);
        let result = restore_verified_backup(
            &live_roots,
            &backup,
            Some(RestoreFailurePoint::AfterAudioInstalled),
        );
        assert!(result.is_err());
        let connection = open_database(&live_roots.db_path).expect("rolled back database");
        let title: String = connection
            .query_row("SELECT title FROM projects WHERE id = 'p'", [], |row| {
                row.get(0)
            })
            .expect("live project remains");
        assert_eq!(title, "Fixture Project");
        assert_eq!(
            fs::read(live_roots.audio_dir.join("p/t1.wav")).expect("restored old audio"),
            b"fixture audio t1"
        );
        assert!(live_roots.artwork_dir.join("p/cover.png").is_file());
        assert_eq!(
            fs::read_dir(live_roots.root.join("backups"))
                .expect("pre-restore backup")
                .count(),
            1
        );
        assert!(!live_roots.root.join(".restore-journal.json").exists());
    }

    #[test]
    fn successful_restore_preserves_notes_versions_moments_sequence_and_capsules() {
        let source = tempdir().expect("source library");
        let source_roots = test_roots(source.path());
        seed_full_library(&source_roots);
        let destination = tempdir().expect("backup destination");
        let backup = create_verified_backup(&source_roots, destination.path()).expect("backup");

        let live = tempdir().expect("live library");
        let live_roots = test_roots(live.path());
        seed_full_library(&live_roots);
        open_database(&live_roots.db_path)
            .expect("live database")
            .execute(
                "UPDATE projects SET title = 'Replace this library' WHERE id = 'p'",
                [],
            )
            .expect("change live fixture");

        restore_verified_backup(&live_roots, &backup, None).expect("successful restore");
        let connection = open_database(&live_roots.db_path).expect("restored database");
        database_integrity(&connection).expect("restored database integrity");
        let title: String = connection
            .query_row("SELECT title FROM projects WHERE id = 'p'", [], |row| {
                row.get(0)
            })
            .expect("restored project title");
        let project_note: String = connection
            .query_row("SELECT text FROM notes WHERE project_id = 'p'", [], |row| {
                row.get(0)
            })
            .expect("restored project note");
        let track_note: String = connection
            .query_row("SELECT text FROM notes WHERE track_id = 't1'", [], |row| {
                row.get(0)
            })
            .expect("restored track note");
        let version_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM tracks WHERE group_id = 'g1'",
                [],
                |row| row.get(0),
            )
            .expect("restored versions");
        let moment_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM moments WHERE track_id = 't1'",
                [],
                |row| row.get(0),
            )
            .expect("restored moments");
        let transition_note: String = connection
            .query_row(
                "SELECT note FROM sequence_transitions WHERE id = 's1'",
                [],
                |row| row.get(0),
            )
            .expect("restored sequence data");
        let capsule_track_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM capsule_tracks WHERE capsule_id = 'c1'",
                [],
                |row| row.get(0),
            )
            .expect("restored Capsule sequence");
        let response_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM capsule_responses WHERE capsule_id = 'c1'",
                [],
                |row| row.get(0),
            )
            .expect("restored Capsule responses");

        assert_eq!(title, "Fixture Project");
        assert_eq!(project_note, "Project note survives");
        assert_eq!(track_note, "Track note survives");
        assert_eq!(version_count, 2);
        assert_eq!(moment_count, 1);
        assert_eq!(transition_note, "Transition survives");
        assert_eq!(capsule_track_count, 2);
        assert_eq!(response_count, 1);
        assert_eq!(
            fs::read(live_roots.audio_dir.join("p/t1.wav")).expect("restored managed audio"),
            b"fixture audio t1"
        );
        assert!(!live_roots.root.join(".restore-journal.json").exists());
        assert_eq!(
            fs::read_dir(live_roots.root.join("backups"))
                .expect("verified pre-restore backup")
                .count(),
            1
        );
    }

    #[test]
    fn failed_rollback_is_reported_and_can_be_recovered_on_restart() {
        let source = tempdir().expect("source library");
        let source_roots = test_roots(source.path());
        seed_full_library(&source_roots);
        let destination = tempdir().expect("backup destination");
        let backup = create_verified_backup(&source_roots, destination.path()).expect("backup");

        let live = tempdir().expect("live library");
        let roots = test_roots(live.path());
        seed_full_library(&roots);
        let error = restore_verified_backup_with_faults(
            &roots,
            &backup,
            Some(RestoreFailurePoint::AfterAudioInstalled),
            true,
        )
        .expect_err("injected rollback failure must be surfaced");
        assert!(error.starts_with("RECOVERY_REQUIRED:"));
        assert!(roots.root.join(".restore-journal.json").is_file());

        recover_interrupted_restore(&roots).expect("startup recovery retries rollback");
        let connection = open_database(&roots.db_path).expect("original database restored");
        let title: String = connection
            .query_row("SELECT title FROM projects WHERE id = 'p'", [], |row| {
                row.get(0)
            })
            .expect("original project remains");
        assert_eq!(title, "Fixture Project");
        assert_eq!(
            fs::read(roots.audio_dir.join("p/t1.wav")).expect("original audio restored"),
            b"fixture audio t1"
        );
        assert!(!roots.root.join(".restore-journal.json").exists());
    }

    #[test]
    fn interrupted_restore_journal_rolls_back_after_process_restart() {
        let live = tempdir().expect("live library");
        let roots = test_roots(live.path());
        seed_full_library(&roots);
        let id = Uuid::new_v4().to_string();
        let (_, rollback_dir, _) = restore_paths(&roots, &id).expect("restore paths");
        fs::create_dir(&rollback_dir).expect("rollback directory");
        for name in ["opal.sqlite", "audio", "artwork"] {
            fs::rename(roots.root.join(name), rollback_dir.join(name))
                .expect("move original to rollback");
        }
        fs::write(roots.root.join("audio"), b"interrupted replacement")
            .expect("partial new audio path");
        write_restore_journal(
            &roots,
            &RestoreJournal {
                id,
                original_items: vec![
                    "opal.sqlite".to_string(),
                    "audio".to_string(),
                    "artwork".to_string(),
                ],
            },
        )
        .expect("journal");

        recover_interrupted_restore(&roots).expect("startup rollback");
        let connection = open_database(&roots.db_path).expect("original database restored");
        let title: String = connection
            .query_row("SELECT title FROM projects WHERE id = 'p'", [], |row| {
                row.get(0)
            })
            .expect("original project");
        assert_eq!(title, "Fixture Project");
        assert_eq!(
            fs::read(roots.audio_dir.join("p/t1.wav")).expect("original audio"),
            b"fixture audio t1"
        );
        assert!(roots.artwork_dir.join("p/cover.png").is_file());
        assert!(!roots.root.join(".restore-journal.json").exists());
    }

    #[test]
    fn generated_audio_corpus_records_codecs_and_decodes_every_advertised_format() {
        let corpus_root =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/audio-corpus");
        let manifest: serde_json::Value = serde_json::from_slice(
            &fs::read(corpus_root.join("manifest.json")).expect("audio corpus manifest"),
        )
        .expect("valid audio corpus manifest");
        let entries = manifest["entries"].as_array().expect("manifest entries");
        assert!(entries.iter().any(|entry| entry["codec"] == "mp3"));
        assert!(entries.iter().any(|entry| entry["codec"] == "flac"));
        assert!(entries.iter().any(|entry| entry["codec"] == "aac"));

        for entry in entries {
            let filename = entry["file"].as_str().expect("audio file name");
            let expected = entry["expected"].as_str().expect("expected outcome");
            let path = corpus_root.join(filename);
            if expected.starts_with("decode") {
                let metadata = extract_audio_metadata(&path)
                    .unwrap_or_else(|error| panic!("{filename} metadata failed: {error}"));
                assert!(metadata.duration_ms > 0, "{filename} duration");
                let waveform = decode_audio_waveform(&path, 72)
                    .unwrap_or_else(|error| panic!("{filename} decode failed: {error}"));
                assert_eq!(waveform.len(), 72, "{filename} waveform length");
                assert!(waveform.iter().all(|peak| (18..=96).contains(peak)));
            } else {
                assert!(
                    extract_audio_metadata(&path).is_err(),
                    "{filename} must not import"
                );
                assert!(
                    decode_audio_waveform(&path, 72).is_err(),
                    "{filename} must not decode"
                );
            }
        }
    }

    #[test]
    fn diagnostics_report_contains_build_identity_without_private_paths() {
        record_diagnostic_error("Library database could not be opened");
        let diagnostics = Diagnostics {
            app_version: APP_VERSION.to_string(),
            build_commit: BUILD_COMMIT.to_string(),
            platform: std::env::consts::OS.to_string(),
            architecture: std::env::consts::ARCH.to_string(),
            database_version: Some(DATABASE_VERSION),
            schema_version: DATABASE_VERSION,
            database_status: "open".to_string(),
            integrity: "ok".to_string(),
            project_count: 1,
            track_count: 2,
            pending_cleanup_count: 0,
            active_import_count: 0,
            recent_errors: recent_diagnostic_errors(),
        };
        let report = serde_json::to_value(diagnostics).expect("serializable diagnostics");
        assert_eq!(report["appVersion"], APP_VERSION);
        assert_eq!(report["schemaVersion"], DATABASE_VERSION);
        assert!(report.get("databasePath").is_none());
        assert!(report["recentErrors"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| {
                entry.as_str().is_some_and(|message| {
                    message.ends_with("Library database could not be opened")
                })
            }));
    }
}
