import { router, useLocalSearchParams } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import { useEffect, useState } from 'react';
import { useSQLiteContext } from 'expo-sqlite';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { IconButton, IconGlyph } from '../../components/IconButton';
import { AmbientCanvas } from '../../components/AmbientCanvas';
import { BottomTabBar } from '../../components/BottomTabBar';
import { MiniPlayer } from '../../components/MiniPlayer';
import { ProjectArtwork } from '../../components/ProjectArtwork';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLibrary } from '../../data/LibraryProvider';
import type { ProjectWithTracks, Track } from '../../data/models';
import { shareProjectReview } from '../../data/review-export';
import { usePlaybackActions, usePlaybackState } from '../../playback/PlaybackProvider';
import { headingFont, palette } from '../../constants/theme';

export default function ProjectScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const db = useSQLiteContext();
  const { getProject, importAudioFiles, renameProject, revision, setCurrentVersion } = useLibrary();
  const { track: playingTrack } = usePlaybackState();
  const { playQueue, playMoment, selectVersion } = usePlaybackActions();
  const [loadedProject, setLoadedProject] = useState<{ id: string; value: ProjectWithTracks | null } | null>(null);
  const [importing, setImporting] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [name, setName] = useState('');

  useEffect(() => {
    let mounted = true;
    void getProject(id).then((nextProject) => {
      if (mounted) {
        setLoadedProject({ id, value: nextProject });
        setName(nextProject?.title ?? '');
      }
    }).catch(() => {
      if (mounted) setLoadedProject({ id, value: null });
    });
    return () => { mounted = false; };
  }, [getProject, id, revision]);

  const project = loadedProject?.id === id ? loadedProject.value : null;
  const loading = loadedProject?.id !== id;
  const songGroups = project ? groupTracks(project.tracks) : [];

  const importAudio = async () => {
    if (!project || importing) return;
    setImporting(true);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: 'audio/*',
        multiple: true,
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      const count = await importAudioFiles(project.id, result.assets);
      if (count > 0) Alert.alert('Added to project', `${count} ${count === 1 ? 'audio file is' : 'audio files are'} ready to listen to offline.`);
      else Alert.alert('No new audio added', 'Those audio files are already in this project.');
    } catch (error) {
      Alert.alert('Could not import audio', error instanceof Error ? error.message : 'Please try another audio file.');
    } finally {
      setImporting(false);
    }
  };

  const saveName = async () => {
    if (!project || !name.trim()) return;
    await renameProject(project.id, name);
    setRenameOpen(false);
  };

  const shareReview = async () => {
    if (!project?.packageId) return;
    try {
      await shareProjectReview(db, project);
    } catch (error) {
      Alert.alert('Could not export review', error instanceof Error ? error.message : 'Please try again.');
    }
  };

  const playMix = (version: Track) => {
    if (playingTrack?.groupId === version.groupId) {
      void selectVersion(version);
    } else if (project) {
      void playMoment(project.tracks, version.id, 0);
    }
  };

  const makeCurrent = async (version: Track) => {
    try {
      await setCurrentVersion(version.projectId, version.id);
    } catch (error) {
      Alert.alert('Could not change the current mix', error instanceof Error ? error.message : 'Please try again.');
    }
  };

  if (loading) {
    return <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}><AmbientCanvas /><View style={styles.loading}><ActivityIndicator color={palette.lavender} /></View><BottomTabBar /><MiniPlayer /></SafeAreaView>;
  }

  if (!project) {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
        <AmbientCanvas />
        <View style={styles.topBar}><IconButton icon="back" label="Back to projects" onPress={() => router.back()} /></View>
        <View style={styles.missing}><Text style={styles.missingTitle}>Project unavailable</Text><Text style={styles.missingCopy}>It may have been removed from this device.</Text></View>
        <BottomTabBar />
        <MiniPlayer />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <AmbientCanvas />
      <View style={styles.topBar}>
        <IconButton icon="back" label="Back to projects" onPress={() => router.back()} />
        <Text style={styles.topLabel}>PROJECT</Text>
        <View style={styles.topActions}>
          <Pressable onPress={() => void shareReview()} disabled={!project.packageId} style={styles.headerAction} accessibilityRole="button" accessibilityLabel={project.packageId ? 'Export review notes for desktop' : 'Review export available after importing this project from desktop'}>
            <IconGlyph icon="open" size={17} color={project.packageId ? palette.text : palette.muted} />
          </Pressable>
          <IconButton icon="more" label="Rename project" onPress={() => setRenameOpen(true)} />
        </View>
      </View>
      <FlatList
        data={songGroups}
        keyExtractor={(group) => group.id}
        renderItem={({ item, index }) => <TrackRow
          group={item}
          index={index}
          onPress={() => void playQueue(project.tracks, index)}
          onVersionPress={playMix}
          onMakeCurrent={makeCurrent}
        />}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={
          <View>
            <View style={styles.projectHero}>
              <ProjectArtwork project={project} size={112} style={styles.heroArtwork} />
              <View style={styles.heroCopy}>
                <Text style={styles.eyebrow}>YOUR PROJECT</Text>
                <Text style={styles.projectTitle} numberOfLines={2}>{project.title}</Text>
                <Text style={styles.projectMeta}>{project.trackCount === 1 ? '1 song' : `${project.trackCount} songs`} <Text style={styles.dot}>·</Text> Stored on this iPhone</Text>
              </View>
            </View>
            <View style={styles.sectionHeading}>
              <View><Text style={styles.sectionEyebrow}>IN SEQUENCE</Text><Text style={styles.sectionTitle}>Songs</Text></View>
              <Pressable onPress={() => void importAudio()} disabled={importing} style={({ pressed }) => [styles.importButton, pressed && styles.pressed, importing && styles.disabled]} accessibilityRole="button" accessibilityLabel={importing ? 'Adding audio files' : 'Add audio files'}>
                {importing ? <ActivityIndicator size="small" color={palette.background} /> : <IconGlyph icon="add" size={17} color={palette.background} />}
                <Text style={styles.importText}>{importing ? 'Adding' : 'Add audio'}</Text>
              </Pressable>
            </View>
            {songGroups.length > 0 && <Text style={styles.queueHint}>Tap a song to play through this project. Open a mix to compare versions.</Text>}
          </View>
        }
        ListEmptyComponent={
          <View style={styles.emptyTracks}>
            <View style={styles.emptyIcon}><IconGlyph icon="music" size={25} color={palette.lavender} /></View>
            <Text style={styles.emptyTitle}>Start with a bounce.</Text>
            <Text style={styles.emptyCopy}>Add a WAV, AIFF, MP3, or M4A file from Files. It will be copied to OPAL for offline listening.</Text>
            <Pressable onPress={() => void importAudio()} disabled={importing} style={({ pressed }) => [styles.emptyImport, pressed && styles.pressed]} accessibilityRole="button" accessibilityLabel={importing ? 'Opening Files' : 'Choose audio files'}>
              <Text style={styles.emptyImportText}>{importing ? 'Opening Files…' : 'Choose audio files'}</Text>
            </Pressable>
          </View>
        }
      />
      <BottomTabBar />
      <MiniPlayer />

      <Modal visible={renameOpen} transparent animationType="fade" onRequestClose={() => setRenameOpen(false)}>
        <View style={styles.modalRoot}>
          <Pressable style={styles.scrim} onPress={() => setRenameOpen(false)} />
          <View style={styles.modalCard}>
            <Text style={styles.modalEyebrow}>PROJECT DETAILS</Text>
            <Text style={styles.modalTitle}>Rename project</Text>
            <TextInput value={name} onChangeText={setName} autoFocus maxLength={80} returnKeyType="done" onSubmitEditing={() => void saveName()} style={styles.input} placeholderTextColor={palette.muted} accessibilityLabel="Project name" />
            <View style={styles.modalActions}>
              <Pressable onPress={() => setRenameOpen(false)} style={styles.cancelButton} accessibilityRole="button" accessibilityLabel="Cancel rename"><Text style={styles.cancelText}>Cancel</Text></Pressable>
              <Pressable onPress={() => void saveName()} style={styles.saveButton} accessibilityRole="button" accessibilityLabel="Save project name"><Text style={styles.saveText}>Save name</Text></Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

type SongGroup = { id: string; title: string; position: number; versions: Track[]; current: Track };

function groupTracks(tracks: Track[]): SongGroup[] {
  const groups = new Map<string, Track[]>();
  for (const track of tracks) groups.set(track.groupId, [...(groups.get(track.groupId) ?? []), track]);
  return [...groups.entries()].map(([id, versions]) => {
    const ordered = versions.sort((left, right) => left.versionPosition - right.versionPosition);
    return { id, title: ordered[0]!.groupTitle, position: ordered[0]!.position, versions: ordered, current: ordered.find((track) => track.isCurrent) ?? ordered[0]! };
  }).sort((left, right) => left.position - right.position);
}

function TrackRow({ group, index, onPress, onVersionPress, onMakeCurrent }: {
  group: SongGroup;
  index: number;
  onPress: () => void;
  onVersionPress: (track: Track) => void;
  onMakeCurrent: (track: Track) => void;
}) {
  return (
    <View style={styles.songGroup}>
    <Pressable onPress={onPress} style={({ pressed }) => [styles.trackRow, pressed && styles.trackPressed]} accessibilityRole="button" accessibilityLabel={`Play ${group.title}, current mix ${group.current.versionName}`}>
      <Text style={styles.trackNumber}>{String(index + 1).padStart(2, '0')}</Text>
      <View style={styles.trackCopy}>
        <Text style={styles.trackTitle} numberOfLines={1}>{group.title}</Text>
        <Text style={styles.trackMeta}>{group.current.versionName}{group.versions.length > 1 ? ` · ${group.versions.length} mixes` : ''} <Text style={styles.dot}>·</Text> {formatBytes(group.current.sizeBytes)}</Text>
      </View>
      <View style={styles.trackPlay}><IconGlyph icon="play" size={15} color={palette.lavenderBright} /></View>
    </Pressable>
    {group.versions.length > 1 && <View style={styles.versionList} accessibilityLabel={`Mix versions of ${group.title}`}>
      {group.versions.map((version) => (
        <View key={version.id} style={styles.versionRow}>
          <Pressable onPress={() => onVersionPress(version)} style={({ pressed }) => [styles.versionChip, version.isCurrent && styles.versionChipCurrent, pressed && styles.trackPressed]} accessibilityRole="button" accessibilityState={{ selected: version.isCurrent }} accessibilityLabel={`Play ${version.versionName}${version.isCurrent ? ', current mix' : ''}`}>
            <Text numberOfLines={1} style={[styles.versionName, version.isCurrent && styles.versionNameCurrent]}>{version.versionName}</Text>
            {version.isCurrent && <Text style={styles.currentTag}>CURRENT</Text>}
          </Pressable>
          {!version.isCurrent && <Pressable onPress={() => onMakeCurrent(version)} hitSlop={6} style={styles.makeCurrentButton} accessibilityRole="button" accessibilityLabel={`Make ${version.versionName} the project's current mix`}><Text style={styles.makeCurrentText}>Make current</Text></Pressable>}
        </View>
      ))}
    </View>}
    </View>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: 'transparent' },
  topBar: { height: 54, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12 },
  topActions: { flexDirection: 'row', alignItems: 'center' },
  headerAction: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 21 },
  topLabel: { color: palette.muted, fontSize: 9, letterSpacing: 2.2, fontWeight: '700' },
  listContent: { paddingHorizontal: 21, paddingBottom: 164 },
  projectHero: { minHeight: 141, flexDirection: 'row', alignItems: 'center', gap: 18, paddingTop: 13, paddingBottom: 28, borderBottomWidth: 1, borderBottomColor: palette.line },
  heroArtwork: { borderRadius: 21 },
  heroCopy: { flex: 1, gap: 7 },
  eyebrow: { color: palette.lavender, fontSize: 9, fontWeight: '700', letterSpacing: 1.7 },
  projectTitle: { color: palette.text, fontFamily: headingFont, fontSize: 27, letterSpacing: -0.7, lineHeight: 31 },
  projectMeta: { color: palette.muted, fontSize: 11 },
  dot: { color: palette.lavender },
  sectionHeading: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, marginTop: 28, marginBottom: 4 },
  sectionEyebrow: { color: palette.lavender, fontSize: 9, letterSpacing: 1.8, fontWeight: '700' },
  sectionTitle: { marginTop: 5, color: palette.text, fontFamily: headingFont, fontSize: 28, letterSpacing: -0.5 },
  importButton: { minHeight: 40, flexDirection: 'row', alignItems: 'center', paddingRight: 13, paddingLeft: 3, borderRadius: 18, backgroundColor: palette.lavender, gap: 2 },
  importIcon: { width: 34, height: 34 },
  importText: { color: palette.background, fontSize: 11, fontWeight: '700' },
  queueHint: { marginTop: 4, marginBottom: 6, color: palette.muted, fontSize: 11 },
  trackRow: { minHeight: 72, flexDirection: 'row', alignItems: 'center', gap: 12, borderTopWidth: 1, borderTopColor: palette.line },
  songGroup: { borderTopWidth: 1, borderTopColor: palette.line },
  trackPressed: { opacity: 0.65 },
  trackNumber: { width: 25, color: palette.muted, fontSize: 11, fontVariant: ['tabular-nums'] },
  trackCopy: { flex: 1, minWidth: 0, gap: 5 },
  trackTitle: { color: palette.text, fontSize: 14, fontWeight: '600' },
  trackMeta: { color: palette.muted, fontSize: 10, letterSpacing: 0.4 },
  trackPlay: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 18, backgroundColor: 'rgba(207, 221, 247, 0.13)' },
  trackPlayButton: { width: 36, height: 36 },
  versionList: { paddingLeft: 37, paddingBottom: 9 },
  versionRow: { minHeight: 39, flexDirection: 'row', alignItems: 'center', gap: 8 },
  versionChip: { minHeight: 31, maxWidth: '63%', flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 10, borderWidth: 1, borderColor: palette.line, borderRadius: 16, backgroundColor: 'rgba(201,214,239,0.07)' },
  versionChipCurrent: { borderColor: 'rgba(207,220,250,0.35)', backgroundColor: 'rgba(207,220,250,0.15)' },
  versionName: { flexShrink: 1, color: palette.secondary, fontSize: 10 },
  versionNameCurrent: { color: palette.text, fontWeight: '600' },
  currentTag: { color: palette.lavenderBright, fontSize: 7, fontWeight: '700', letterSpacing: 0.8 },
  makeCurrentButton: { minHeight: 31, justifyContent: 'center', paddingHorizontal: 7 },
  makeCurrentText: { color: palette.lavenderBright, fontSize: 9, fontWeight: '600' },
  emptyTracks: { alignItems: 'center', paddingHorizontal: 22, paddingTop: 30, paddingBottom: 28, borderTopWidth: 1, borderTopColor: palette.line },
  emptyIcon: { width: 56, height: 56, alignItems: 'center', justifyContent: 'center', borderRadius: 28, borderWidth: 1, borderColor: 'rgba(231, 239, 255, 0.24)', backgroundColor: 'rgba(207, 221, 247, 0.12)' },
  emptyTitle: { marginTop: 16, color: palette.text, fontFamily: headingFont, fontSize: 23 },
  emptyCopy: { maxWidth: 290, marginTop: 8, color: palette.secondary, fontSize: 13, lineHeight: 20, textAlign: 'center' },
  emptyImport: { marginTop: 18, paddingVertical: 12, paddingHorizontal: 17, borderRadius: 22, backgroundColor: palette.lavender },
  emptyImportText: { color: palette.background, fontSize: 12, fontWeight: '700' },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  missing: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30 },
  missingTitle: { color: palette.text, fontFamily: headingFont, fontSize: 24 },
  missingCopy: { marginTop: 8, color: palette.muted, fontSize: 13 },
  modalRoot: { flex: 1, justifyContent: 'center', paddingHorizontal: 20 },
  scrim: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(8, 15, 29, 0.72)' },
  modalCard: { padding: 23, borderWidth: 1, borderColor: 'rgba(239,244,255,0.24)', borderRadius: 24, backgroundColor: palette.surface },
  modalEyebrow: { color: palette.lavender, fontSize: 9, letterSpacing: 1.8, fontWeight: '700' },
  modalTitle: { marginTop: 10, color: palette.text, fontFamily: headingFont, fontSize: 26 },
  input: { marginTop: 18, paddingHorizontal: 14, paddingVertical: 13, borderWidth: 1, borderColor: palette.line, borderRadius: 13, color: palette.text, fontSize: 15, backgroundColor: 'rgba(0,0,0,0.12)' },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 10, marginTop: 18 },
  cancelButton: { paddingVertical: 12, paddingHorizontal: 14 },
  cancelText: { color: palette.secondary, fontSize: 13 },
  saveButton: { minWidth: 100, minHeight: 42, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14, borderRadius: 14, backgroundColor: palette.lavender },
  saveText: { color: palette.background, fontSize: 12, fontWeight: '700' },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.75 },
});
