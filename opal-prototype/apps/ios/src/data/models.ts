export type Project = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  artworkIndex: number;
  trackCount: number;
  durationMs: number;
};

export type Track = {
  id: string;
  projectId: string;
  projectTitle: string;
  artworkIndex: number;
  title: string;
  sourceName: string;
  fileName: string;
  format: string;
  sha256: string;
  sizeBytes: number;
  durationMs: number;
  position: number;
  createdAt: number;
};

export type ProjectWithTracks = Project & { tracks: Track[] };

export type Moment = {
  id: string;
  trackId: string;
  projectId: string;
  timeMs: number;
  text: string;
  state: 'question' | 'keep' | 'change' | 'idea';
  createdAt: number;
  updatedAt: number;
};

export type PlaybackBookmark = {
  trackId: string;
  projectId: string;
  positionMs: number;
};
