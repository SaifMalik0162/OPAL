import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import * as Crypto from 'expo-crypto';
import type { DocumentPickerAsset } from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
import { useSQLiteContext } from 'expo-sqlite';
import { getMoments, getProject } from './database';
import type { Moment, Project, ProjectWithTracks } from './models';

const audioRoot = new Directory(Paths.document, 'OPAL', 'Audio');
const stagingDirectory = new Directory(Paths.document, 'OPAL', 'Staging');
const supportedExtensions = new Set(['wav', 'mp3', 'm4a', 'aif', 'aiff']);

function queryProjects(db: ReturnType<typeof useSQLiteContext>) {
  return db.getAllAsync<Project>(`
    SELECT id, title, created_at AS createdAt, updated_at AS updatedAt,
      artwork_index AS artworkIndex,
      (SELECT COUNT(*) FROM tracks WHERE project_id = projects.id) AS trackCount,
      COALESCE((SELECT SUM(duration_ms) FROM tracks WHERE project_id = projects.id), 0) AS durationMs
    FROM projects ORDER BY updated_at DESC, created_at DESC
  `);
}

type LibraryContextValue = {
  projects: Project[];
  loading: boolean;
  revision: number;
  refresh: () => Promise<void>;
  createProject: (title: string) => Promise<string>;
  renameProject: (id: string, title: string) => Promise<void>;
  getProject: (id: string) => Promise<ProjectWithTracks | null>;
  getMoments: (trackId: string) => Promise<Moment[]>;
  importAudioFiles: (projectId: string, assets: DocumentPickerAsset[]) => Promise<number>;
  createMoment: (trackId: string, projectId: string, timeMs: number, text: string) => Promise<void>;
};

const LibraryContext = createContext<LibraryContextValue | null>(null);

export function LibraryProvider({ children }: { children: ReactNode }) {
  const db = useSQLiteContext();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);

  const refresh = useCallback(async () => {
    const rows = await queryProjects(db);
    setProjects(rows);
    setLoading(false);
  }, [db]);

  useEffect(() => {
    let mounted = true;
    void queryProjects(db).then((rows) => {
      if (!mounted) return;
      setProjects(rows);
      setLoading(false);
    }).catch(() => {
      if (mounted) setLoading(false);
    });
    return () => { mounted = false; };
  }, [db]);

  const createProject = useCallback(async (title: string) => {
    const id = Crypto.randomUUID();
    const now = Date.now();
    const cleanTitle = title.trim() || 'Untitled project';
    await db.runAsync(
      'INSERT INTO projects (id, title, created_at, updated_at, artwork_index) VALUES (?, ?, ?, ?, ?)',
      id,
      cleanTitle,
      now,
      now,
      Math.floor(Math.random() * 3),
    );
    setRevision((value) => value + 1);
    await refresh();
    return id;
  }, [db, refresh]);

  const renameProject = useCallback(async (id: string, title: string) => {
    const cleanTitle = title.trim();
    if (!cleanTitle) return;
    await db.runAsync('UPDATE projects SET title = ?, updated_at = ? WHERE id = ?', cleanTitle, Date.now(), id);
    setRevision((value) => value + 1);
    await refresh();
  }, [db, refresh]);

  const loadProject = useCallback((id: string) => getProject(db, id), [db]);
  const loadMoments = useCallback((trackId: string) => getMoments(db, trackId), [db]);

  const importAudioFiles = useCallback(async (projectId: string, assets: DocumentPickerAsset[]) => {
    const unsupported = assets.filter((asset) => {
      const extension = asset.name.split('.').pop()?.toLowerCase() ?? '';
      return !supportedExtensions.has(extension);
    });
    if (unsupported.length) {
      throw new Error(`OPAL cannot import ${unsupported.map((asset) => asset.name).join(', ')} yet. Choose WAV, AIFF, MP3, or M4A files.`);
    }

    const requiredBytes = assets.reduce((total, asset) => {
      const size = asset.size ?? new File(asset.uri).info().size ?? 0;
      return total + size;
    }, 0);
    const storageHeadroom = 32 * 1024 * 1024;
    if (requiredBytes > 0 && requiredBytes + storageHeadroom > Paths.availableDiskSpace) {
      throw new Error('There is not enough free space to import these files. Free up space and try again.');
    }

    const project = await loadProject(projectId);
    if (!project) throw new Error('This project is no longer available.');
    const destinationDirectory = new Directory(audioRoot, projectId);
    destinationDirectory.create({ idempotent: true, intermediates: true });
    stagingDirectory.create({ idempotent: true, intermediates: true });
    let imported = 0;

    for (const asset of assets) {
      const extension = asset.name.split('.').pop()?.toLowerCase() ?? 'audio';
      const id = Crypto.randomUUID();
      const stagedFile = new File(stagingDirectory, `${id}.partial`);
      const relativeFileName = `${projectId}/${id}.${extension}`;
      const finalFile = new File(destinationDirectory, `${id}.${extension}`);

      try {
        await new File(asset.uri).copy(stagedFile);
        const sha256 = await stagedFile.digest('SHA-256');
        const duplicate = await db.getFirstAsync<{ id: string }>(
          'SELECT id FROM tracks WHERE project_id = ? AND sha256 = ? LIMIT 1',
          projectId,
          sha256,
        );
        if (duplicate) {
          stagedFile.delete();
          continue;
        }

        const position = await db.getFirstAsync<{ nextPosition: number }>(
          'SELECT COALESCE(MAX(position), -1) + 1 AS nextPosition FROM tracks WHERE project_id = ?',
          projectId,
        );
        const info = stagedFile.info();
        const now = Date.now();
        await stagedFile.move(finalFile);

        try {
          await db.runAsync(`
            INSERT INTO tracks (
              id, project_id, title, source_name, file_name, format, sha256,
              size_bytes, duration_ms, position, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
          `,
          id,
          projectId,
          trackTitle(asset.name),
          asset.name,
          relativeFileName,
          extension.toUpperCase(),
          sha256,
          asset.size ?? info.size ?? 0,
          position?.nextPosition ?? 0,
          now,
          );
        } catch (error) {
          if (finalFile.exists) finalFile.delete();
          throw error;
        }
        imported += 1;
      } catch (error) {
        if (stagedFile.exists) stagedFile.delete();
        if (imported > 0) {
          await db.runAsync('UPDATE projects SET updated_at = ? WHERE id = ?', Date.now(), projectId);
          setRevision((value) => value + 1);
          await refresh();
        }
        throw error;
      }
    }

    await db.runAsync('UPDATE projects SET updated_at = ? WHERE id = ?', Date.now(), projectId);
    setRevision((value) => value + 1);
    await refresh();
    return imported;
  }, [db, loadProject, refresh]);

  const createMoment = useCallback(async (trackId: string, projectId: string, timeMs: number, text: string) => {
    const now = Date.now();
    await db.runAsync(`
      INSERT INTO moments (id, track_id, project_id, time_ms, text, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'question', ?, ?)
    `, Crypto.randomUUID(), trackId, projectId, Math.max(0, Math.round(timeMs)), text.trim(), now, now);
    await db.runAsync('UPDATE projects SET updated_at = ? WHERE id = ?', now, projectId);
    setRevision((value) => value + 1);
    await refresh();
  }, [db, refresh]);

  const value = useMemo<LibraryContextValue>(() => ({
    projects,
    loading,
    revision,
    refresh,
    createProject,
    renameProject,
    getProject: loadProject,
    getMoments: loadMoments,
    importAudioFiles,
    createMoment,
  }), [projects, loading, revision, refresh, createProject, renameProject, loadProject, loadMoments, importAudioFiles, createMoment]);

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

export function useLibrary() {
  const value = useContext(LibraryContext);
  if (!value) throw new Error('useLibrary must be used inside LibraryProvider.');
  return value;
}

function trackTitle(fileName: string) {
  const dot = fileName.lastIndexOf('.');
  const base = dot > 0 ? fileName.slice(0, dot) : fileName;
  return base.replace(/[_]+/g, ' ').trim() || fileName;
}
