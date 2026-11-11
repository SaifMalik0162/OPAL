import type { SQLiteDatabase } from 'expo-sqlite';
import { Directory, File, Paths } from 'expo-file-system';
import type { Moment, PlaybackBookmark, Project, ProjectWithTracks, SequenceTransition, Track } from './models';

const audioRoot = new Directory(Paths.document, 'OPAL', 'Audio');
const artworkRoot = new Directory(Paths.document, 'OPAL', 'Artwork');
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

  const migratedVersion = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((migratedVersion?.user_version ?? 0) < 2) {
    await db.withTransactionAsync(async () => {
      await db.execAsync(`
        ALTER TABLE projects ADD COLUMN description TEXT NOT NULL DEFAULT '';
        ALTER TABLE projects ADD COLUMN note_text TEXT NOT NULL DEFAULT '';
        ALTER TABLE projects ADD COLUMN source_project_id TEXT;
        ALTER TABLE projects ADD COLUMN package_id TEXT;
        ALTER TABLE projects ADD COLUMN snapshot_id TEXT;
        ALTER TABLE projects ADD COLUMN artwork_file_name TEXT;
        ALTER TABLE projects ADD COLUMN artwork_size_bytes INTEGER NOT NULL DEFAULT 0;

        ALTER TABLE tracks ADD COLUMN group_id TEXT;
        ALTER TABLE tracks ADD COLUMN group_title TEXT NOT NULL DEFAULT '';
        ALTER TABLE tracks ADD COLUMN version_name TEXT NOT NULL DEFAULT 'Original';
        ALTER TABLE tracks ADD COLUMN version_position INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE tracks ADD COLUMN is_current INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE tracks ADD COLUMN note_text TEXT NOT NULL DEFAULT '';
        UPDATE tracks SET group_id = id, group_title = title WHERE group_id IS NULL OR group_title = '';
        CREATE INDEX tracks_group_version ON tracks(project_id, group_id, version_position);

        ALTER TABLE moments ADD COLUMN lineage_id TEXT NOT NULL DEFAULT '';
        ALTER TABLE moments ADD COLUMN is_resolved INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE moments ADD COLUMN parent_id TEXT;
        UPDATE moments SET lineage_id = id WHERE lineage_id = '';
        CREATE INDEX moments_lineage ON moments(lineage_id);

        CREATE TABLE sequence_transitions (
          id TEXT PRIMARY KEY NOT NULL,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          from_group_id TEXT NOT NULL,
          to_group_id TEXT NOT NULL,
          gap_ms INTEGER NOT NULL DEFAULT 0 CHECK (gap_ms >= 0 AND gap_ms <= 600000),
          note TEXT NOT NULL DEFAULT '',
          updated_at INTEGER NOT NULL,
          UNIQUE(project_id, from_group_id, to_group_id),
          CHECK (from_group_id <> to_group_id)
        );
        CREATE INDEX sequence_transitions_project ON sequence_transitions(project_id);

        CREATE TABLE imported_packages (
          package_id TEXT PRIMARY KEY NOT NULL,
          snapshot_id TEXT NOT NULL,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          imported_at INTEGER NOT NULL
        );
        PRAGMA user_version = 2;
      `);
    });
  }

  const artworkHashVersion = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((artworkHashVersion?.user_version ?? 0) < 3) {
    await db.withTransactionAsync(async () => {
      const projectColumns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(projects)');
      if (!projectColumns.some((column) => column.name === 'artwork_sha256')) {
        await db.execAsync('ALTER TABLE projects ADD COLUMN artwork_sha256 TEXT');
      }
      await db.execAsync('PRAGMA user_version = 3');
    });
  }

  const storageMetadataVersion = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((storageMetadataVersion?.user_version ?? 0) < 4) {
    await db.withTransactionAsync(async () => {
      const projectColumns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(projects)');
      const existingNames = new Set(projectColumns.map((column) => column.name));
      if (!existingNames.has('artwork_size_bytes')) {
        await db.execAsync('ALTER TABLE projects ADD COLUMN artwork_size_bytes INTEGER NOT NULL DEFAULT 0');
      }
      if (!existingNames.has('artwork_sha256')) {
        await db.execAsync('ALTER TABLE projects ADD COLUMN artwork_sha256 TEXT');
      }
      await db.execAsync('PRAGMA user_version = 4');
    });
  }

  audioRoot.create({ idempotent: true, intermediates: true });
  artworkRoot.create({ idempotent: true, intermediates: true });
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

  const artworkRows = await db.getAllAsync<{ artworkFileName: string | null }>(
    'SELECT artwork_file_name AS artworkFileName FROM projects WHERE artwork_file_name IS NOT NULL',
  );
  const managedArtwork = new Set(artworkRows.map((row) => row.artworkFileName));
  for (const projectEntry of artworkRoot.list()) {
    if (!(projectEntry instanceof Directory)) continue;
    for (const artworkEntry of projectEntry.list()) {
      if (!(artworkEntry instanceof File)) continue;
      const relativeName = `${projectEntry.name}/${artworkEntry.name}`;
      if (!managedArtwork.has(relativeName)) {
        try { artworkEntry.delete(); } catch { /* Retried on the next launch. */ }
      }
    }
  }
}

export function audioUri(fileName: string) {
  return new File(audioRoot, fileName).uri;
}

export function artworkUri(fileName: string | null | undefined) {
  return fileName ? new File(artworkRoot, fileName).uri : null;
}

export async function getProject(db: SQLiteDatabase, id: string): Promise<ProjectWithTracks | null> {
  const row = await db.getFirstAsync<Project & { artworkFileName: string | null }>(`
    SELECT id, title, description, note_text AS note, created_at AS createdAt, updated_at AS updatedAt,
      artwork_index AS artworkIndex, artwork_file_name AS artworkFileName,
      source_project_id AS sourceProjectId, package_id AS packageId, snapshot_id AS snapshotId,
      (SELECT COUNT(DISTINCT COALESCE(group_id, id)) FROM tracks WHERE project_id = projects.id) AS trackCount,
      COALESCE((SELECT SUM(duration_ms) FROM tracks WHERE project_id = projects.id AND is_current = 1), 0) AS durationMs
    FROM projects WHERE id = ?
  `, id);
  if (!row) return null;
  const project = { ...row, artworkUri: artworkUri(row.artworkFileName) };

  const tracks = await db.getAllAsync<Track & { artworkFileName: string | null }>(`
    SELECT tracks.id, tracks.project_id AS projectId, projects.title AS projectTitle,
      projects.artwork_index AS artworkIndex, projects.artwork_file_name AS artworkFileName,
      tracks.group_id AS groupId, tracks.group_title AS groupTitle,
      tracks.title, tracks.source_name AS sourceName, tracks.file_name AS fileName,
      tracks.version_name AS versionName, tracks.version_position AS versionPosition,
      tracks.is_current AS isCurrent, tracks.note_text AS note,
      tracks.format, tracks.sha256, tracks.size_bytes AS sizeBytes,
      tracks.duration_ms AS durationMs, tracks.position, tracks.created_at AS createdAt
    FROM tracks JOIN projects ON projects.id = tracks.project_id
    WHERE tracks.project_id = ? ORDER BY tracks.position ASC, tracks.version_position ASC, tracks.created_at ASC
  `, id);
  return { ...project, tracks: tracks.map((track) => ({ ...track, artworkUri: artworkUri(track.artworkFileName), isCurrent: Boolean(track.isCurrent) })) };
}

export async function getMoments(db: SQLiteDatabase, trackId: string): Promise<Moment[]> {
  const moments = await db.getAllAsync<Moment>(`
    SELECT id, track_id AS trackId, project_id AS projectId, time_ms AS timeMs,
      text, state, lineage_id AS lineageId, is_resolved AS isResolved, parent_id AS parentId,
      created_at AS createdAt, updated_at AS updatedAt
    FROM moments WHERE track_id = ? ORDER BY time_ms ASC
  `, trackId);
  return moments.map((moment) => ({ ...moment, isResolved: Boolean(moment.isResolved) }));
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

export async function getProjectTransitions(db: SQLiteDatabase, projectId: string): Promise<SequenceTransition[]> {
  return db.getAllAsync<SequenceTransition>(`
    SELECT id, project_id AS projectId, from_group_id AS fromGroupId,
      to_group_id AS toGroupId, gap_ms AS gapMs, note, updated_at AS updatedAt
    FROM sequence_transitions WHERE project_id = ? ORDER BY updated_at ASC
  `, projectId);
}

export type ProjectStorageUsage = Pick<Project, 'id' | 'title' | 'trackCount'> & {
  audioBytes: number;
  artworkBytes: number;
};

export async function getStorageUsage(db: SQLiteDatabase): Promise<{
  projects: ProjectStorageUsage[];
  audioBytes: number;
  artworkBytes: number;
  databaseBytes: number;
}> {
  const rows = await db.getAllAsync<ProjectStorageUsage>(`
    SELECT projects.id, projects.title,
      (SELECT COUNT(*) FROM tracks WHERE project_id = projects.id) AS trackCount,
      COALESCE((SELECT SUM(size_bytes) FROM tracks WHERE project_id = projects.id), 0) AS audioBytes,
      projects.artwork_size_bytes AS artworkBytes
    FROM projects ORDER BY projects.updated_at DESC
  `);
  const databaseFiles = [
    new File(Paths.document, 'SQLite', 'opal-library.db'),
    new File(Paths.document, 'SQLite', 'opal-library.db-wal'),
    new File(Paths.document, 'SQLite', 'opal-library.db-shm'),
  ];
  const audioBytes = rows.reduce((total, project) => total + project.audioBytes, 0);
  const artworkBytes = rows.reduce((total, project) => total + project.artworkBytes, 0);
  const databaseBytes = databaseFiles.reduce((total, file) => {
    try {
      return total + (file.exists ? file.info().size ?? 0 : 0);
    } catch {
      return total;
    }
  }, 0);
  return { projects: rows, audioBytes, artworkBytes, databaseBytes };
}
