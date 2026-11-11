import { File, Paths } from 'expo-file-system';
import type { SQLiteDatabase } from 'expo-sqlite';
import { Share } from 'react-native';
import { getMoments } from './database';
import type { OpalReviewExportV1, ProjectWithTracks } from './models';

export async function shareProjectReview(db: SQLiteDatabase, project: ProjectWithTracks) {
  if (!project.packageId || !project.snapshotId || !project.sourceProjectId) {
    throw new Error('This project has not been transferred from OPAL Desktop yet.');
  }

  const allMoments = (await Promise.all(project.tracks.map((track) => getMoments(db, track.id)))).flat();
  const moments = allMoments.map((moment) => ({
    id: moment.id,
    trackId: moment.trackId,
    lineageId: moment.lineageId || moment.id,
    timeMs: moment.timeMs,
    state: moment.state,
    text: moment.text,
    isResolved: moment.isResolved,
    parentId: moment.parentId,
    createdAt: moment.createdAt,
    updatedAt: moment.updatedAt,
  }));
  const payload: OpalReviewExportV1 = {
    format: 'opal-review',
    formatVersion: 1,
    packageId: project.packageId,
    snapshotId: project.snapshotId,
    projectId: project.sourceProjectId,
    exportedAt: Date.now(),
    moments,
  };
  const slug = project.title.normalize('NFKD').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'OPAL-project';
  const reviewFile = new File(Paths.cache, `${slug}-review.opalreview`);
  if (reviewFile.exists) reviewFile.delete();
  reviewFile.create({ intermediates: true });
  await reviewFile.write(JSON.stringify(payload, null, 2));
  await Share.share({ title: `${project.title} review`, url: reviewFile.uri });
}
