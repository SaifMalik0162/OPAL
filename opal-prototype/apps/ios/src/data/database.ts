import type { SQLiteDatabase } from 'expo-sqlite';
import { Directory, File, Paths } from 'expo-file-system';
import type { Moment, PlaybackBookmark, Project, ProjectWithTracks, Track } from './models';

const audioRoot = new Directory(Paths.document, 'OPAL', 'Audio');
const stagingDirectory = new Directory(Paths.document, 'OPAL', 'Staging');

export async function initializeDatabase(db: SQLiteDatabase) {
  await db.execAsync('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  const version = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');

  if ((version?.user_version ?? 0) < 1) {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        artwork_index INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS tracks (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        source_name TEXT NOT NULL,
        file_name TEXT NOT NULL UNIQUE,
        format TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        position INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tracks_project_position ON tracks(project_id, position);
      CREATE INDEX IF NOT EXISTS tracks_project_hash ON tracks(project_id, sha256);
      CREATE TABLE IF NOT EXISTS moments (
        id TEXT PRIMARY KEY NOT NULL,
        track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        time_ms INTEGER NOT NULL,
        text TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT 'question',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS moments_track_time ON moments(track_id, time_ms);
      CREATE TABLE IF NOT EXISTS playback_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        track_id TEXT REFERENCES tracks(id) ON DELETE SET NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        position_ms INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      PRAGMA user_version = 1;
    `);
  }

  audioRoot.create({ idempotent: true, intermediates: true });
  stagingDirectory.create({ idempotent: true, intermediates: true });
  await removeOrphanedAudio(db);
  await clearInterruptedImports();
}

async function clearInterruptedImports() {
  for (const entry of stagingDirectory.list()) {
    try {
      entry.delete();
    } catch {
      // A later launch can retry cleanup if the OS temporarily protects a picked file.
    }
  }
}

async function removeOrphanedAudio(db: SQLiteDatabase) {
  const rows = await db.getAllAsync<{ fileName: string }>('SELECT file_name AS fileName FROM tracks');
  const managed = new Set(rows.map((row) => row.fileName));

  for (const projectEntry of audioRoot.list()) {
    if (!(projectEntry instanceof Directory)) continue;
    for (const audioEntry of projectEntry.list()) {
      if (!(audioEntry instanceof File)) continue;
      const relativeName = `${projectEntry.name}/${audioEntry.name}`;
      if (!managed.has(relativeName)) {
        try {
          audioEntry.delete();
        } catch {
          // Orphans remain safe to play and cleanup is retried at the next launch.
        }
      }
    }
  }
}

export function audioUri(fileName: string) {
  return new File(audioRoot, fileName).uri;
}

export async function getProject(db: SQLiteDatabase, id: string): Promise<ProjectWithTracks | null> {
  const row = await db.getFirstAsync<Project>(`
    SELECT id, title, created_at AS createdAt, updated_at AS updatedAt,
      artwork_index AS artworkIndex,
      (SELECT COUNT(*) FROM tracks WHERE project_id = projects.id) AS trackCount,
      COALESCE((SELECT SUM(duration_ms) FROM tracks WHERE project_id = projects.id), 0) AS durationMs
    FROM projects WHERE id = ?
  `, id);
  if (!row) return null;

  const tracks = await db.getAllAsync<Track>(`
    SELECT tracks.id, tracks.project_id AS projectId, projects.title AS projectTitle,
      projects.artwork_index AS artworkIndex,
      tracks.title, tracks.source_name AS sourceName, tracks.file_name AS fileName,
      tracks.format, tracks.sha256, tracks.size_bytes AS sizeBytes,
      tracks.duration_ms AS durationMs, tracks.position, tracks.created_at AS createdAt
    FROM tracks JOIN projects ON projects.id = tracks.project_id
    WHERE tracks.project_id = ? ORDER BY tracks.position ASC, tracks.created_at ASC
  `, id);
  return { ...row, tracks };
}

export async function getMoments(db: SQLiteDatabase, trackId: string): Promise<Moment[]> {
  return db.getAllAsync<Moment>(`
    SELECT id, track_id AS trackId, project_id AS projectId, time_ms AS timeMs,
      text, state, created_at AS createdAt, updated_at AS updatedAt
    FROM moments WHERE track_id = ? ORDER BY time_ms ASC
  `, trackId);
}

export async function readPlaybackBookmark(db: SQLiteDatabase): Promise<PlaybackBookmark | null> {
  return db.getFirstAsync<PlaybackBookmark>(`
    SELECT track_id AS trackId, project_id AS projectId, position_ms AS positionMs
    FROM playback_state WHERE id = 1 AND track_id IS NOT NULL AND project_id IS NOT NULL
  `);
}

export async function savePlaybackBookmark(
  db: SQLiteDatabase,
  bookmark: PlaybackBookmark | null,
) {
  await db.runAsync(`
    INSERT INTO playback_state (id, track_id, project_id, position_ms, updated_at)
    VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET track_id = excluded.track_id,
      project_id = excluded.project_id, position_ms = excluded.position_ms,
      updated_at = excluded.updated_at
  `, bookmark?.trackId ?? null, bookmark?.projectId ?? null, bookmark?.positionMs ?? 0, Date.now());
}
