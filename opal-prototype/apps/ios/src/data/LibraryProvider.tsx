import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import * as Crypto from 'expo-crypto';
import type { DocumentPickerAsset } from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
import { useSQLiteContext } from 'expo-sqlite';
import { artworkUri, getMoments, getProject, getProjectTransitions, getStorageUsage } from './database';
import { cleanupStagedPackage, extensionForAssetPath, readAndStageProjectPackage } from './project-package';
import type { Moment, Project, ProjectWithTracks, SequenceTransition } from './models';

const audioRoot = new Directory(Paths.document, 'OPAL', 'Audio');
const artworkRoot = new Directory(Paths.document, 'OPAL', 'Artwork');
const stagingDirectory = new Directory(Paths.document, 'OPAL', 'Staging');
const supportedExtensions = new Set(['wav', 'mp3', 'flac', 'm4a', 'aif', 'aiff']);

function queryProjects(db: ReturnType<typeof useSQLiteContext>) {
  return db.getAllAsync<Project & { artworkFileName: string | null }>(`
    SELECT id, title, created_at AS createdAt, updated_at AS updatedAt,
      artwork_index AS artworkIndex, artwork_file_name AS artworkFileName,
      (SELECT COUNT(DISTINCT COALESCE(group_id, id)) FROM tracks WHERE project_id = projects.id) AS trackCount,
      COALESCE((SELECT SUM(duration_ms) FROM tracks WHERE project_id = projects.id AND is_current = 1), 0) AS durationMs
    FROM projects ORDER BY updated_at DESC, created_at DESC
  `).then((rows) => rows.map((row) => ({ ...row, artworkUri: artworkUri(row.artworkFileName) })));
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
  getProjectTransitions: (projectId: string) => Promise<SequenceTransition[]>;
  getStorageUsage: () => ReturnType<typeof getStorageUsage>;
  importAudioFiles: (projectId: string, assets: DocumentPickerAsset[]) => Promise<number>;
  importProjectPackage: (file: File) => Promise<'imported' | 'updated' | 'alreadyImported'>;
  deleteProject: (id: string) => Promise<void>;
  setCurrentVersion: (projectId: string, trackId: string) => Promise<void>;
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
  const loadProjectTransitions = useCallback((projectId: string) => getProjectTransitions(db, projectId), [db]);
  const loadStorageUsage = useCallback(() => getStorageUsage(db), [db]);

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
              size_bytes, duration_ms, position, created_at,
              group_id, group_title, version_name, version_position, is_current
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 'Original', 0, 1)
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
          id,
          trackTitle(asset.name),
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

  const importProjectPackage = useCallback(async (packageFile: File) => {
    const staged = await readAndStageProjectPackage(packageFile);
    const { manifest } = staged;
    const createdFiles: File[] = [];
    let committed = false;
    try {
      const prior = await db.getFirstAsync<{ snapshotId: string }>(
        'SELECT snapshot_id AS snapshotId FROM imported_packages WHERE package_id = ?', manifest.packageId,
      );
      const collision = await db.getFirstAsync<{ id: string }>('SELECT id FROM projects WHERE id = ?', manifest.project.id);
      if (!prior && collision) throw new Error('A different local project already uses this project ID. Export or rename that project before importing.');
      if (prior && !collision) throw new Error('The transferred project record is missing. Keep this package and restore the project database before retrying.');

      const stagedByPath = new Map(staged.assets.map((asset) => [asset.asset.path, asset]));
      const audioDirectory = new Directory(audioRoot, manifest.project.id);
      audioDirectory.create({ idempotent: true, intermediates: true });
      const existingTracks = new Map((await db.getAllAsync<{ id: string; sha256: string; fileName: string; projectId: string }>(
        'SELECT id, sha256, file_name AS fileName, project_id AS projectId FROM tracks WHERE project_id = ?', manifest.project.id,
      )).map((track) => [track.id, track]));
      for (const track of manifest.tracks) {
        const collisionTrack = await db.getFirstAsync<{ projectId: string }>(
          'SELECT project_id AS projectId FROM tracks WHERE id = ?', track.id,
        );
        if (collisionTrack && collisionTrack.projectId !== manifest.project.id) {
          throw new Error('A mix in this package conflicts with a different local project.');
        }
      }
      const existingArtwork = await db.getFirstAsync<{ artworkFileName: string | null; artworkSha256: string | null }>(
        'SELECT artwork_file_name AS artworkFileName, artwork_sha256 AS artworkSha256 FROM projects WHERE id = ?', manifest.project.id,
      );
      const reusableAudioFiles = new Map<string, string>();
      for (const track of manifest.tracks) {
        const existing = existingTracks.get(track.id);
        if (existing?.sha256 !== track.sha256) continue;
        const existingFile = new File(audioRoot, existing.fileName);
        if (existingFile.exists && (await existingFile.digest('SHA-256')).toLowerCase() === track.sha256) {
          reusableAudioFiles.set(track.id, existing.fileName);
        }
      }
      const artworkAsset = manifest.project.artworkAsset ? stagedByPath.get(manifest.project.artworkAsset)?.asset : undefined;
      let reusableArtworkFileName: string | null = null;
      if (artworkAsset && existingArtwork?.artworkSha256 === artworkAsset.sha256 && existingArtwork.artworkFileName) {
        const existingFile = new File(artworkRoot, existingArtwork.artworkFileName);
        if (existingFile.exists && (await existingFile.digest('SHA-256')).toLowerCase() === artworkAsset.sha256) {
          reusableArtworkFileName = existingArtwork.artworkFileName;
        }
      }
      if (prior?.snapshotId === manifest.snapshotId &&
          manifest.tracks.every((track) => reusableAudioFiles.has(track.id)) &&
          (artworkAsset ? reusableArtworkFileName !== null : !existingArtwork?.artworkFileName)) {
        return 'alreadyImported' as const;
      }
      const addedBytes = manifest.tracks.reduce((total, track) => total + (reusableAudioFiles.has(track.id) ? 0 : track.sizeBytes), 0) +
        (artworkAsset && !reusableArtworkFileName ? artworkAsset.sizeBytes : 0);
      if (addedBytes + 64 * 1024 * 1024 > Paths.availableDiskSpace) {
        throw new Error('There is not enough free space to keep offline copies of every song version.');
      }

      const localAudioNames = new Map<string, string>();
      for (const track of manifest.tracks) {
        const existingFileName = reusableAudioFiles.get(track.id);
        if (existingFileName) {
          localAudioNames.set(track.id, existingFileName);
          continue;
        }
        const stagedAsset = stagedByPath.get(track.assetPath);
        if (!stagedAsset) throw new Error(`The audio for ${track.groupTitle} is missing from the staged package.`);
        const extension = extensionForAssetPath(track.assetPath);
        let fileName = `${track.id}-${track.sha256.slice(0, 12)}.${extension}`;
        let destination = new File(audioDirectory, fileName);
        if (destination.exists && (await destination.digest('SHA-256')).toLowerCase() !== track.sha256) {
          fileName = `${track.id}-${track.sha256.slice(0, 12)}-${Crypto.randomUUID()}.${extension}`;
          destination = new File(audioDirectory, fileName);
        }
        if (!destination.exists) {
          await stagedAsset.file.copy(destination);
          createdFiles.push(destination);
        }
        if ((await destination.digest('SHA-256')).toLowerCase() !== track.sha256) {
          throw new Error('A copied offline mix failed its SHA-256 check. Keep the package and retry the import.');
        }
        localAudioNames.set(track.id, `${manifest.project.id}/${fileName}`);
      }

      let artworkFileName: string | null = reusableArtworkFileName;
      let artworkSizeBytes = 0;
      let artworkSha256: string | null = null;
      if (manifest.project.artworkAsset) {
        const stagedArtwork = stagedByPath.get(manifest.project.artworkAsset);
        if (!stagedArtwork) throw new Error('The project artwork is missing from the staged package.');
        const extension = extensionForAssetPath(stagedArtwork.asset.path);
        artworkFileName ??= `${manifest.project.id}/${stagedArtwork.asset.sha256}.${extension}`;
        artworkSha256 = stagedArtwork.asset.sha256;
        artworkSizeBytes = stagedArtwork.asset.sizeBytes;
        if (!reusableArtworkFileName) {
          const artworkDirectory = new Directory(artworkRoot, manifest.project.id);
          artworkDirectory.create({ idempotent: true, intermediates: true });
          let destination = new File(artworkRoot, artworkFileName);
          if (destination.exists && (await destination.digest('SHA-256')).toLowerCase() !== artworkSha256) {
            artworkFileName = `${manifest.project.id}/${stagedArtwork.asset.sha256}-${Crypto.randomUUID()}.${extension}`;
            destination = new File(artworkRoot, artworkFileName);
          }
          if (!destination.exists) {
            await stagedArtwork.file.copy(destination);
            createdFiles.push(destination);
          }
          if ((await destination.digest('SHA-256')).toLowerCase() !== artworkSha256) {
            throw new Error('The copied project artwork failed its SHA-256 check. Keep the package and retry the import.');
          }
        }
      }

      const now = Date.now();
      const existingMomentIds = new Set(await db.getAllAsync<{ id: string }>(
        'SELECT id FROM moments WHERE project_id = ?', manifest.project.id,
      ).then((rows) => rows.map((row) => row.id)));
      for (const track of manifest.tracks) {
        for (const moment of track.moments) {
          if (!existingMomentIds.has(moment.id)) continue;
          const existingMoment = await db.getFirstAsync<{ trackId: string; projectId: string }>(
            'SELECT track_id AS trackId, project_id AS projectId FROM moments WHERE id = ?', moment.id,
          );
          if (existingMoment?.projectId !== manifest.project.id || existingMoment.trackId !== track.id) {
            throw new Error('A review moment in the package conflicts with an existing local note.');
          }
        }
      }

      await db.withTransactionAsync(async () => {
        if (prior) {
          await db.runAsync(`
            UPDATE projects SET title = ?, description = ?, note_text = ?, created_at = ?, updated_at = ?,
              artwork_file_name = ?, artwork_size_bytes = ?, artwork_sha256 = ?, source_project_id = ?,
              package_id = ?, snapshot_id = ? WHERE id = ?
          `, manifest.project.title, manifest.project.description, manifest.project.note?.text ?? '',
          manifest.project.createdAt, Math.max(now, manifest.project.updatedAt), artworkFileName,
          artworkSizeBytes, artworkSha256, manifest.project.id, manifest.packageId, manifest.snapshotId, manifest.project.id);
          await db.runAsync('UPDATE tracks SET is_current = 0 WHERE project_id = ?', manifest.project.id);
        } else {
          await db.runAsync(`
            INSERT INTO projects (
              id, title, description, note_text, created_at, updated_at, artwork_index,
              artwork_file_name, artwork_size_bytes, artwork_sha256, source_project_id, package_id, snapshot_id
            ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
          `, manifest.project.id, manifest.project.title, manifest.project.description,
          manifest.project.note?.text ?? '', manifest.project.createdAt, manifest.project.updatedAt,
          artworkFileName, artworkSizeBytes, artworkSha256, manifest.project.id, manifest.packageId, manifest.snapshotId);
        }

        for (const track of manifest.tracks) {
          const existing = existingTracks.get(track.id);
          if (existing) {
            await db.runAsync(`
              UPDATE tracks SET title = ?, source_name = ?, file_name = ?, format = ?, sha256 = ?,
                size_bytes = ?, duration_ms = ?, position = ?, group_id = ?, group_title = ?,
                version_name = ?, version_position = ?, is_current = ?, note_text = ? WHERE id = ? AND project_id = ?
            `, track.title, track.sourceTitle, localAudioNames.get(track.id)!, track.format, track.sha256,
            track.sizeBytes, track.durationMs, track.position, track.groupId, track.groupTitle,
            track.versionName, track.versionPosition, Number(track.isCurrent), track.note?.text ?? '', track.id, manifest.project.id);
          } else {
            await db.runAsync(`
              INSERT INTO tracks (
                id, project_id, title, source_name, file_name, format, sha256,
                size_bytes, duration_ms, position, created_at, group_id, group_title,
                version_name, version_position, is_current, note_text
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, track.id, manifest.project.id, track.title, track.sourceTitle, localAudioNames.get(track.id)!,
            track.format, track.sha256, track.sizeBytes, track.durationMs, track.position,
            manifest.project.createdAt, track.groupId, track.groupTitle, track.versionName,
            track.versionPosition, Number(track.isCurrent), track.note?.text ?? '');
          }
          for (const moment of track.moments) {
            await db.runAsync(`
              INSERT INTO moments (
                id, track_id, project_id, time_ms, text, state, created_at, updated_at,
                lineage_id, is_resolved, parent_id
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO NOTHING
            `, moment.id, track.id, manifest.project.id, moment.timeMs, moment.text, moment.state,
            moment.createdAt, moment.updatedAt, moment.lineageId, Number(moment.isResolved), moment.parentId);
          }
        }
        await db.runAsync('DELETE FROM sequence_transitions WHERE project_id = ?', manifest.project.id);
        for (const transition of manifest.transitions) {
          await db.runAsync(`
            INSERT INTO sequence_transitions (id, project_id, from_group_id, to_group_id, gap_ms, note, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `, transition.id, manifest.project.id, transition.fromGroupId, transition.toGroupId,
          transition.gapMs, transition.note, transition.updatedAt);
        }
        if (prior) {
          await db.runAsync('UPDATE imported_packages SET snapshot_id = ?, imported_at = ? WHERE package_id = ?', manifest.snapshotId, now, manifest.packageId);
        } else {
          await db.runAsync(
            'INSERT INTO imported_packages (package_id, snapshot_id, project_id, imported_at) VALUES (?, ?, ?, ?)',
            manifest.packageId, manifest.snapshotId, manifest.project.id, now,
          );
        }
      });
      committed = true;
      setRevision((value) => value + 1);
      await refresh();
      return prior ? 'updated' as const : 'imported' as const;
    } finally {
      cleanupStagedPackage(staged);
      if (!committed) {
        for (const file of createdFiles) {
          try { if (file.exists) file.delete(); } catch { /* Startup orphan cleanup retries this path. */ }
        }
      }
    }
  }, [db, refresh]);

  const deleteProject = useCallback(async (id: string) => {
    const project = await loadProject(id);
    if (!project) return;
    await db.withTransactionAsync(async () => {
      await db.runAsync('DELETE FROM projects WHERE id = ?', id);
    });
    const projectAudio = new Directory(audioRoot, id);
    const projectArtwork = new Directory(artworkRoot, id);
    try { if (projectAudio.exists) projectAudio.delete(); } catch { /* Startup orphan cleanup retries this path. */ }
    try { if (projectArtwork.exists) projectArtwork.delete(); } catch { /* Startup orphan cleanup retries this path. */ }
    setRevision((value) => value + 1);
    await refresh();
  }, [db, loadProject, refresh]);

  const setCurrentVersion = useCallback(async (projectId: string, trackId: string) => {
    await db.withTransactionAsync(async () => {
      const track = await db.getFirstAsync<{ groupId: string }>(
        'SELECT group_id AS groupId FROM tracks WHERE id = ? AND project_id = ?', trackId, projectId,
      );
      if (!track) throw new Error('This mix is no longer available in the project.');
      await db.runAsync('UPDATE tracks SET is_current = 0 WHERE project_id = ? AND group_id = ?', projectId, track.groupId);
      await db.runAsync('UPDATE tracks SET is_current = 1 WHERE id = ? AND project_id = ?', trackId, projectId);
      await db.runAsync('UPDATE projects SET updated_at = ? WHERE id = ?', Date.now(), projectId);
    });
    setRevision((value) => value + 1);
    await refresh();
  }, [db, refresh]);

  const createMoment = useCallback(async (trackId: string, projectId: string, timeMs: number, text: string) => {
    const now = Date.now();
    const id = Crypto.randomUUID();
    await db.runAsync(`
      INSERT INTO moments (id, track_id, project_id, time_ms, text, state, created_at, updated_at, lineage_id)
      VALUES (?, ?, ?, ?, ?, 'question', ?, ?, ?)
    `, id, trackId, projectId, Math.max(0, Math.round(timeMs)), text.trim(), now, now, id);
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
    getProjectTransitions: loadProjectTransitions,
    getStorageUsage: loadStorageUsage,
    importAudioFiles,
    importProjectPackage,
    deleteProject,
    setCurrentVersion,
    createMoment,
  }), [projects, loading, revision, refresh, createProject, renameProject, loadProject, loadMoments, loadProjectTransitions, loadStorageUsage, importAudioFiles, importProjectPackage, deleteProject, setCurrentVersion, createMoment]);

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
