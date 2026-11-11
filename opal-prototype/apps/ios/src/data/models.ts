export type Project = {
  id: string;
  title: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
  artworkIndex: number;
  artworkUri?: string | null;
  note?: string;
  sourceProjectId?: string | null;
  packageId?: string | null;
  snapshotId?: string | null;
  trackCount: number;
  durationMs: number;
};

export type Track = {
  id: string;
  projectId: string;
  projectTitle: string;
  artworkIndex: number;
  artworkUri?: string | null;
  groupId: string;
  groupTitle: string;
  title: string;
  versionName: string;
  versionPosition: number;
  isCurrent: boolean;
  sourceName: string;
  fileName: string;
  format: string;
  sha256: string;
  sizeBytes: number;
  durationMs: number;
  position: number;
  createdAt: number;
  note?: string;
};

export type ProjectWithTracks = Project & { tracks: Track[] };

export type Moment = {
  id: string;
  trackId: string;
  projectId: string;
  timeMs: number;
  text: string;
  state: 'question' | 'keep' | 'change' | 'idea';
  lineageId: string;
  isResolved: boolean;
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
};

export type PlaybackBookmark = {
  trackId: string;
  projectId: string;
  positionMs: number;
};

export type SequenceTransition = {
  id: string;
  projectId: string;
  fromGroupId: string;
  toGroupId: string;
  gapMs: number;
  note: string;
  updatedAt: number;
};

export type ProjectPackageAsset = {
  path: string;
  role: 'audio' | 'artwork';
  sha256: string;
  sizeBytes: number;
  mimeType: string;
};

export type OpalProjectPackageV1 = {
  format: 'opal-project';
  formatVersion: 1;
  packageId: string;
  snapshotId: string;
  createdAt: number;
  project: {
    id: string;
    title: string;
    description: string;
    createdAt: number;
    updatedAt: number;
    artworkAsset: string | null;
    note: { id: string; text: string; updatedAt: number } | null;
  };
  tracks: {
    id: string;
    groupId: string;
    groupTitle: string;
    title: string;
    sourceTitle: string;
    position: number;
    versionName: string;
    versionPosition: number;
    isCurrent: boolean;
    durationMs: number;
    format: string;
    assetPath: string;
    sha256: string;
    sizeBytes: number;
    note: { id: string; text: string; updatedAt: number } | null;
    moments: {
      id: string;
      trackId: string;
      lineageId: string;
      timeMs: number;
      state: Moment['state'];
      text: string;
      isResolved: boolean;
      parentId: string | null;
      createdAt: number;
      updatedAt: number;
    }[];
  }[];
  transitions: SequenceTransition[];
  assets: ProjectPackageAsset[];
};

export type OpalReviewExportV1 = {
  format: 'opal-review';
  formatVersion: 1;
  packageId: string;
  snapshotId: string;
  projectId: string;
  exportedAt: number;
  moments: OpalProjectPackageV1['tracks'][number]['moments'];
};
