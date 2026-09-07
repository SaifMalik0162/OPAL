use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use image::ImageFormat;
use lofty::{
    file::{AudioFile, TaggedFileExt},
    probe::Probe,
    tag::Accessor,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager};
use uuid::Uuid;

const APP_VERSION: &str = "0.1.0-alpha.1";
const DATABASE_VERSION: i64 = 3;

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
    title: String,
    position: i64,
    duration_ms: i64,
    duration: String,
    format: String,
    managed_file_ref: String,
    managed_file_path: Option<String>,
    note: Option<NoteDto>,
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
    database_version: Option<i64>,
    database_path: String,
    database_status: String,
    integrity: String,
    project_count: usize,
    track_count: usize,
    pending_cleanup_count: usize,
    active_import_count: usize,
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

fn storage_roots(app: &tauri::AppHandle) -> Result<StorageRoots, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not locate OPAL app storage: {error}"))?;
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

fn backup_database_before_migration(path: &Path) -> Result<Option<PathBuf>, String> {
    if !path.is_file() {
        return Ok(None);
    }
    let backup_dir = path
        .parent()
        .ok_or_else(|| "Could not locate OPAL backup folder.".to_string())?
        .join("backups");
    fs::create_dir_all(&backup_dir)
        .map_err(|error| format!("Could not create OPAL migration backup folder: {error}"))?;
    let backup_path = backup_dir.join(format!("opal-pre-migration-{}.sqlite", now_ms()));
    fs::copy(path, &backup_path)
        .map_err(|error| format!("Could not create a recoverable migration backup: {error}"))?;
    Ok(Some(backup_path))
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
          CREATE TABLE tracks (
            id TEXT PRIMARY KEY NOT NULL,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            position INTEGER NOT NULL,
            duration_ms INTEGER NOT NULL DEFAULT 0,
            format TEXT NOT NULL,
            managed_file_ref TEXT NOT NULL,
            source_hash TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(project_id, position)
          );
          CREATE INDEX tracks_project_position ON tracks(project_id, position);
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
          PRAGMA user_version = 3;
        ",
            )
            .map_err(|error| format!("Could not migrate OPAL database: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("Could not commit OPAL database migration: {error}"))?;
    } else if version == 1 {
        backup_database_before_migration(path)?;
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
          PRAGMA user_version = 3;
        ",
            )
            .map_err(|error| format!("Could not migrate OPAL database: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("Could not commit OPAL database migration: {error}"))?;
    } else if version == 2 {
        backup_database_before_migration(path)?;
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
          PRAGMA user_version = 3;
        ",
            )
            .map_err(|error| format!("Could not migrate OPAL database: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("Could not commit OPAL database migration: {error}"))?;
    } else if version > DATABASE_VERSION {
        return Err(format!(
            "RECOVERY_REQUIRED: OPAL database version {version} is newer than this app."
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

fn extract_audio_metadata(path: &Path) -> AudioMetadata {
    let fallback = fallback_title(path);
    match Probe::open(path).and_then(|probe| probe.read()) {
        Ok(tagged_file) => {
            let title = tagged_file
                .primary_tag()
                .or_else(|| tagged_file.first_tag())
                .and_then(|tag| tag.title())
                .map(|title| title.into_owned())
                .filter(|title| !title.trim().is_empty())
                .unwrap_or(fallback);
            AudioMetadata {
                title,
                duration_ms: tagged_file.properties().duration().as_millis() as i64,
                warning: None,
            }
        }
        Err(_) => AudioMetadata {
            title: fallback,
            duration_ms: 0,
            warning: Some("Metadata unavailable; stored with the filename.".to_string()),
        },
    }
}

fn track_from_row(row: &rusqlite::Row<'_>, roots: &StorageRoots) -> rusqlite::Result<TrackDto> {
    let duration_ms: i64 = row.get(4)?;
    let managed_file_ref: String = row.get(6)?;
    let managed_file_path = roots.root.join(&managed_file_ref);
    Ok(TrackDto {
        id: row.get(0)?,
        project_id: row.get(1)?,
        title: row.get(2)?,
        position: row.get(3)?,
        duration_ms,
        duration: format_track_duration(duration_ms),
        format: row.get(5)?,
        managed_file_ref,
        managed_file_path: managed_file_path
            .is_file()
            .then(|| managed_file_path.to_string_lossy().into_owned()),
        note: None,
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
            "SELECT id, project_id, title, position, duration_ms, format, managed_file_ref
       FROM tracks WHERE project_id = ?1 ORDER BY position ASC",
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
    }
    let project_note = load_project_note(connection, project_id)?;
    let duration_ms = tracks.iter().map(|track| track.duration_ms).sum();
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
        type_label: project_type(tracks.len()),
        count: tracks.len(),
        duration_ms,
        duration: format_project_duration(duration_ms),
        tracks,
        project_note,
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
    let roots = prepare_storage(&app)?;
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("A track needs a title.".to_string());
    }
    let connection = open_database(&roots.db_path)?;
    let changed = connection
        .execute(
            "UPDATE tracks SET title = ?1 WHERE id = ?2 AND project_id = ?3",
            params![title, track_id, project_id],
        )
        .map_err(|error| format!("Could not rename track: {error}"))?;
    if changed == 0 {
        return Err("Track no longer exists in this project.".to_string());
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

#[tauri::command(rename = "saveNote", rename_all = "camelCase")]
fn save_note(
    app: tauri::AppHandle,
    project_id: Option<String>,
    track_id: Option<String>,
    text: String,
) -> Result<NoteDto, String> {
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
    let roots = prepare_storage(&app)?;
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

    let batch_dir = roots
        .staging_dir
        .join(format!("artwork-{}", Uuid::new_v4()));
    fs::create_dir_all(&batch_dir).map_err(|error| format!("Could not stage artwork: {error}"))?;
    let staged_source = batch_dir.join(format!("source.{}", extension(&source)));
    fs::copy(&source, &staged_source)
        .map_err(|error| format!("Could not copy artwork into staging: {error}"))?;
    let thumbnail = image::open(&staged_source)
        .map_err(|_| "OPAL could not decode that artwork image.".to_string())?
        .thumbnail(1200, 1200);
    let thumbnail_path = batch_dir.join("thumb.jpg");
    thumbnail
        .save_with_format(&thumbnail_path, ImageFormat::Jpeg)
        .map_err(|error| format!("Could not create artwork thumbnail: {error}"))?;

    let final_dir = roots.artwork_dir.join(&project_id);
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
    let artwork_ref = format!("artwork/{project_id}/thumb.jpg");
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
    let roots = prepare_storage(&app)?;
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
    let artwork_dir = roots.artwork_dir.join(&project_id);
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
) -> Result<ImportSummary, String> {
    let _guard = state.begin(&project_id)?;
    import_audio_files_inner(app, project_id, paths, allow_duplicates)
}

fn import_audio_files_inner(
    app: tauri::AppHandle,
    project_id: String,
    paths: Vec<String>,
    allow_duplicates: bool,
) -> Result<ImportSummary, String> {
    let roots = prepare_storage(&app)?;
    if paths.is_empty() {
        return Ok(ImportSummary {
            results: Vec::new(),
            duplicate_paths: Vec::new(),
            imported_count: 0,
        });
    }
    let connection = open_database(&roots.db_path)?;
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

        let metadata = extract_audio_metadata(&source);
        let track_id = Uuid::new_v4().to_string();
        let staged_file = batch_dir.join(format!("{track_id}.{}", extension(&source)));
        if let Err(error) = fs::copy(&source, &staged_file) {
            let message = format!("Could not copy into OPAL storage: {error}");
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
        let project_audio_dir = roots.audio_dir.join(&project_id);
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
        if let Err(error) = fs::rename(&staged_file, &managed_path) {
            let _ = fs::remove_file(&staged_file);
            let message = format!("Could not commit managed audio: {error}");
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
        let track = TrackDto {
            id: track_id.clone(),
            project_id: project_id.clone(),
            title: metadata.title,
            position,
            duration_ms: metadata.duration_ms,
            duration: format_track_duration(metadata.duration_ms),
            format: extension(&source).to_uppercase(),
            managed_file_ref: managed_file_ref.clone(),
            managed_file_path: Some(managed_path.to_string_lossy().into_owned()),
            note: None,
        };
        let insert_result = connection.execute(
      "INSERT INTO tracks (id, project_id, title, position, duration_ms, format, managed_file_ref, source_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
      params![track.id, track.project_id, track.title, track.position, track.duration_ms, track.format, track.managed_file_ref, source_hash, now_ms()],
    );
        if let Err(error) = insert_result {
            let _ = fs::remove_file(&managed_path);
            let message = format!("Could not save the imported track: {error}");
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
        connection
            .execute(
                "UPDATE projects SET updated_at = ?1 WHERE id = ?2",
                params![now_ms(), project_id],
            )
            .map_err(|error| format!("Could not update project timestamp: {error}"))?;
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
        return Ok(());
    }
    fs::create_dir_all(destination)
        .map_err(|error| format!("Could not create backup folder: {error}"))?;
    for entry in
        fs::read_dir(source).map_err(|error| format!("Could not read managed storage: {error}"))?
    {
        let entry =
            entry.map_err(|error| format!("Could not read managed storage entry: {error}"))?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        if source_path.is_dir() {
            copy_directory(&source_path, &destination_path)?;
        } else {
            fs::copy(&source_path, &destination_path)
                .map_err(|error| format!("Could not copy backup file: {error}"))?;
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

fn backup_manifest_for(
    connection: &Connection,
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
    let manifest: BackupManifest = serde_json::from_slice(
        &fs::read(&manifest_path)
            .map_err(|error| format!("Could not read backup manifest: {error}"))?,
    )
    .map_err(|error| format!("The OPAL backup manifest is invalid: {error}"))?;
    if manifest.format_version != 1
        || manifest.database != "opal.sqlite"
        || manifest.audio_directory != "audio"
        || manifest.artwork_directory != "artwork"
    {
        return Err("This OPAL backup was created by an incompatible version.".to_string());
    }
    let connection = open_database(&database_path)?;
    database_integrity(&connection)?;
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| format!("The OPAL backup database is unreadable: {error}"))?;
    if version > DATABASE_VERSION {
        return Err("This OPAL backup needs a newer version of OPAL.".to_string());
    }
    let (project_count, track_count) = storage_counts(&connection)?;
    if project_count != manifest.project_count || track_count != manifest.track_count {
        return Err("The OPAL backup manifest does not match its database.".to_string());
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
    let roots = prepare_storage(&app)?;
    let path = safe_managed_path(&roots, &managed_file_ref)?;
    if !path.is_file() {
        return Err("This managed audio file is missing.".to_string());
    }
    reveal_in_file_manager(&path)
}

#[tauri::command(rename = "exportBackup", rename_all = "camelCase")]
fn export_backup(app: tauri::AppHandle, destination: String) -> Result<String, String> {
    let roots = prepare_storage(&app)?;
    let destination = PathBuf::from(destination);
    if !destination.is_dir() {
        return Err("Choose a folder for the OPAL backup.".to_string());
    }
    let connection = open_database(&roots.db_path)?;
    database_integrity(&connection)?;
    let backup_dir = destination.join(format!("OPAL Backup {}", now_ms()));
    fs::create_dir_all(&backup_dir)
        .map_err(|error| format!("Could not create the OPAL backup: {error}"))?;
    fs::copy(&roots.db_path, backup_dir.join("opal.sqlite"))
        .map_err(|error| format!("Could not copy the OPAL database: {error}"))?;
    copy_directory(&roots.audio_dir, &backup_dir.join("audio"))?;
    copy_directory(&roots.artwork_dir, &backup_dir.join("artwork"))?;
    let manifest = backup_manifest_for(&connection, now_ms())?;
    let manifest_json = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| format!("Could not create the OPAL backup manifest: {error}"))?;
    let mut manifest_file = File::create(backup_dir.join("manifest.json"))
        .map_err(|error| format!("Could not write the OPAL backup manifest: {error}"))?;
    manifest_file
        .write_all(&manifest_json)
        .map_err(|error| format!("Could not write the OPAL backup manifest: {error}"))?;
    Ok(backup_dir.to_string_lossy().into_owned())
}

#[tauri::command(rename = "restoreBackup", rename_all = "camelCase")]
fn restore_backup(
    app: tauri::AppHandle,
    state: tauri::State<'_, StartupState>,
    source_path: String,
) -> Result<StorageInfo, String> {
    let roots = storage_roots(&app)?;
    let source = PathBuf::from(source_path);
    validate_backup(&source)?;
    let restore_dir = roots.root.join(format!(".restore-{}", Uuid::new_v4()));
    fs::create_dir_all(&restore_dir)
        .map_err(|error| format!("Could not stage the OPAL restore: {error}"))?;
    let current_backup = roots
        .root
        .join("backups")
        .join(format!("opal-pre-restore-{}", now_ms()));
    let restore_result = (|| {
        fs::copy(source.join("opal.sqlite"), restore_dir.join("opal.sqlite"))
            .map_err(|error| format!("Could not stage the OPAL database: {error}"))?;
        copy_directory(&source.join("audio"), &restore_dir.join("audio"))?;
        copy_directory(&source.join("artwork"), &restore_dir.join("artwork"))?;
        let restored_connection = open_database(&restore_dir.join("opal.sqlite"))?;
        database_integrity(&restored_connection)?;
        fs::create_dir_all(&current_backup)
            .map_err(|error| format!("Could not protect the current OPAL library: {error}"))?;
        if roots.db_path.is_file() {
            fs::copy(&roots.db_path, current_backup.join("opal.sqlite"))
                .map_err(|error| format!("Could not protect the current OPAL database: {error}"))?;
        }
        copy_directory(&roots.audio_dir, &current_backup.join("audio"))?;
        copy_directory(&roots.artwork_dir, &current_backup.join("artwork"))?;
        fs::copy(restore_dir.join("opal.sqlite"), &roots.db_path)
            .map_err(|error| format!("Could not install the restored OPAL database: {error}"))?;
        if roots.audio_dir.exists() {
            fs::remove_dir_all(&roots.audio_dir)
                .map_err(|error| format!("Could not replace managed audio: {error}"))?;
        }
        if roots.artwork_dir.exists() {
            fs::remove_dir_all(&roots.artwork_dir)
                .map_err(|error| format!("Could not replace managed artwork: {error}"))?;
        }
        copy_directory(&restore_dir.join("audio"), &roots.audio_dir)?;
        copy_directory(&restore_dir.join("artwork"), &roots.artwork_dir)?;
        Ok::<(), String>(())
    })();
    let _ = fs::remove_dir_all(&restore_dir);
    if let Err(error) = restore_result {
        if current_backup.join("opal.sqlite").is_file() {
            let _ = fs::copy(current_backup.join("opal.sqlite"), &roots.db_path);
        }
        let _ = fs::remove_dir_all(&roots.audio_dir);
        let _ = copy_directory(&current_backup.join("audio"), &roots.audio_dir);
        let _ = fs::remove_dir_all(&roots.artwork_dir);
        let _ = copy_directory(&current_backup.join("artwork"), &roots.artwork_dir);
        let _ = initialise_storage(&roots);
        return Err(format!("Could not complete the OPAL restore: {error}"));
    }
    initialise_storage(&roots)?;
    if let Ok(mut storage_error) = state.storage_error.lock() {
        *storage_error = None;
    }
    storage_info_for(&roots)
}

#[tauri::command(rename = "retryStorage", rename_all = "camelCase")]
fn retry_storage(app: tauri::AppHandle) -> Result<StorageInfo, String> {
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
    let roots = match storage_roots(&app) {
        Ok(roots) => roots,
        Err(error) => {
            return Diagnostics {
                app_version: APP_VERSION.to_string(),
                database_version: None,
                database_path: String::new(),
                database_status: error,
                integrity: "unavailable".to_string(),
                project_count: 0,
                track_count: 0,
                pending_cleanup_count: 0,
                active_import_count: app
                    .try_state::<ImportState>()
                    .and_then(|state| state.active_projects.lock().ok().map(|set| set.len()))
                    .unwrap_or(0),
            };
        }
    };
    let connection = open_database(&roots.db_path);
    let (
        database_version,
        database_status,
        integrity,
        project_count,
        track_count,
        pending_cleanup_count,
    ) = match connection {
        Ok(connection) => {
            let version = connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .ok();
            let integrity = database_integrity(&connection)
                .map(|_| "ok".to_string())
                .unwrap_or_else(|error| error);
            let (projects, tracks) = storage_counts(&connection).unwrap_or((0, 0));
            let pending = connection
                .query_row("SELECT COUNT(*) FROM cleanup_queue", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap_or(0);
            (
                version,
                "open".to_string(),
                integrity,
                projects,
                tracks,
                pending as usize,
            )
        }
        Err(error) => (None, error, "unavailable".to_string(), 0, 0, 0),
    };
    let active_import_count = app
        .try_state::<ImportState>()
        .and_then(|state| state.active_projects.lock().ok().map(|set| set.len()))
        .unwrap_or(0);
    Diagnostics {
        app_version: APP_VERSION.to_string(),
        database_version,
        database_path: roots.db_path.to_string_lossy().into_owned(),
        database_status,
        integrity,
        project_count,
        track_count,
        pending_cleanup_count,
        active_import_count,
    }
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
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            let roots = storage_roots(app.handle()).expect("OPAL storage path should be available");
            if let Err(error) = initialise_storage(&roots) {
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
            save_note,
            delete_track,
            delete_project,
            set_project_artwork,
            remove_project_artwork,
            import_audio_files,
            get_storage_info,
            reveal_storage_folder,
            reveal_managed_file,
            export_backup,
            restore_backup,
            retry_storage,
            get_import_status,
            get_diagnostics
        ])
        .run(tauri::generate_context!())
        .expect("error while running OPAL");
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn database_migration_is_idempotent() {
        let directory = tempdir().expect("temporary database directory");
        let database = directory.path().join("opal.sqlite");
        initialise_database(&database).expect("first migration");
        initialise_database(&database).expect("second migration");
        let connection = open_database(&database).expect("open migrated database");
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("version");
        assert_eq!(version, 3);
        connection.execute("INSERT INTO projects (id, title, created_at, updated_at) VALUES ('p', 'Project', 1, 1)", []).expect("project insert");
        connection.execute("INSERT INTO tracks (id, project_id, title, position, format, managed_file_ref, source_hash, created_at) VALUES ('t', 'p', 'Track', 0, 'WAV', 'audio/p/t.wav', 'hash', 1)", []).expect("track insert");
        let title: String = connection
            .query_row("SELECT title FROM tracks WHERE id = 't'", [], |row| {
                row.get(0)
            })
            .expect("track title");
        assert_eq!(title, "Track");
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
        assert_eq!(version, 3);
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
}
