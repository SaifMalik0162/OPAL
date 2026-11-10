import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Slider from '@react-native-community/slider';
import { IconButton, IconGlyph } from '../components/IconButton';
import { ProjectArtwork } from '../components/ProjectArtwork';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLibrary } from '../data/LibraryProvider';
import type { Moment, ProjectWithTracks } from '../data/models';
import { usePlaybackActions, usePlaybackState } from '../playback/PlaybackProvider';
import { headingFont, palette } from '../constants/theme';

export default function NowPlayingScreen() {
  const { track, playing, loading, positionMs, durationMs, error, queue, queueIndex } = usePlaybackState();
  const { capturePosition, playMoment, seek, skip, toggle } = usePlaybackActions();
  const { createMoment, getMoments, getProject, revision } = useLibrary();
  const [details, setDetails] = useState<{ trackId: string; project: ProjectWithTracks | null; moments: Moment[] } | null>(null);
  const [scrubValue, setScrubValue] = useState(0);
  const [scrubbing, setScrubbing] = useState(false);
  const [momentOpen, setMomentOpen] = useState(false);
  const [momentTarget, setMomentTarget] = useState<{ trackId: string; projectId: string; timeMs: number } | null>(null);
  const [momentText, setMomentText] = useState('');
  const [savingMoment, setSavingMoment] = useState(false);

  const currentTrackId = track?.id ?? null;
  const currentProjectId = track?.projectId ?? null;

  useEffect(() => {
    if (!currentTrackId || !currentProjectId) return;
    let mounted = true;
    void Promise.all([getProject(currentProjectId), getMoments(currentTrackId)]).then(([nextProject, nextMoments]) => {
      if (mounted) {
        setDetails({ trackId: currentTrackId, project: nextProject, moments: nextMoments });
      }
    });
    return () => { mounted = false; };
  }, [getMoments, getProject, revision, currentTrackId, currentProjectId]);

  const project = details?.trackId === currentTrackId ? details.project : null;
  const moments = details?.trackId === currentTrackId ? details.moments : [];

  const openMoment = () => {
    if (!track) return;
    setMomentTarget({ trackId: track.id, projectId: track.projectId, timeMs: capturePosition() });
    setMomentText('');
    setMomentOpen(true);
  };

  const saveMoment = async () => {
    if (!momentTarget || savingMoment) return;
    setSavingMoment(true);
    try {
      await createMoment(momentTarget.trackId, momentTarget.projectId, momentTarget.timeMs, momentText);
      setMomentOpen(false);
    } finally {
      setSavingMoment(false);
    }
  };

  const reopenMoment = (moment: Moment) => {
    if (!project || !track) return;
    void playMoment(project.tracks, track.id, moment.timeMs);
  };

  if (!track) {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
        <View style={styles.topBar}><IconButton icon="back" label="Back to library" onPress={() => router.canGoBack() ? router.back() : router.replace('/')} /><Text style={styles.topLabel}>NOW PLAYING</Text><View style={styles.topSpacer} /></View>
        <View style={styles.emptyState}>
          <ProjectArtwork project={{ artworkIndex: 1 }} size={104} style={styles.emptyArtwork} />
          <Text style={styles.emptyTitle}>Nothing in the room yet.</Text>
          <Text style={styles.emptyCopy}>Choose a song from one of your projects and take a listening moment.</Text>
          <Pressable onPress={() => router.canGoBack() ? router.back() : router.replace('/')} style={styles.backButton}><Text style={styles.backButtonText}>Back to projects</Text></Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const totalSeconds = durationMs / 1000;
  const displayedSeconds = scrubbing ? scrubValue : positionMs / 1000;
  const recentMoments = moments.slice(-4).reverse();

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <View style={styles.topBar}>
        <IconButton icon="back" label="Back" onPress={() => router.canGoBack() ? router.back() : router.replace('/')} />
        <View style={styles.nowPlayingTitle}><Text style={styles.topLabel}>NOW PLAYING</Text><Text numberOfLines={1} style={styles.topProject}>{track.projectTitle}</Text></View>
        <View style={styles.topSpacer} />
      </View>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.artworkWrap}>
          <ProjectArtwork project={track} size={Math.min(340, 0.84 * 400)} style={styles.cover} />
          <View style={styles.artworkEdge} />
        </View>

        <View style={styles.trackHeading}>
          <View style={styles.trackTitleWrap}>
            <Text style={styles.trackTitle} numberOfLines={2}>{track.title}</Text>
            <Text style={styles.trackSubtitle}>{track.projectTitle} <Text style={styles.subtitleDot}>·</Text> {track.format}</Text>
          </View>
          <View style={styles.localBadge}><View style={styles.localDot} /><Text style={styles.localText}>OFFLINE</Text></View>
        </View>

        <View style={styles.scrubber}>
          <Slider
            value={Math.min(displayedSeconds, totalSeconds || displayedSeconds)}
            minimumValue={0}
            maximumValue={Math.max(totalSeconds, 1)}
            disabled={!durationMs || loading}
            onSlidingStart={() => setScrubbing(true)}
            onValueChange={setScrubValue}
            onSlidingComplete={(value) => {
              setScrubbing(false);
              void seek(value * 1000);
            }}
            minimumTrackTintColor={palette.lavenderBright}
            maximumTrackTintColor="rgba(244,240,247,0.17)"
            thumbTintColor={palette.text}
            accessibilityLabel="Playback position"
          />
          <View style={styles.timeLabels}><Text style={styles.timeText}>{formatTime(displayedSeconds * 1000)}</Text><Text style={styles.timeText}>{formatTime(durationMs)}</Text></View>
        </View>

        <View style={styles.controls}>
          <IconButton icon="previous" label="Previous song" onPress={() => skip(-1)} color={palette.secondary} size={24} style={styles.skipButton} />
          <Pressable onPress={toggle} disabled={loading} accessibilityRole="button" accessibilityLabel={playing ? 'Pause playback' : 'Start playback'} style={({ pressed }) => [styles.mainPlay, pressed && styles.mainPlayPressed, loading && styles.disabled]}>
            {loading ? <ActivityIndicator color={palette.background} /> : <IconGlyph icon={playing ? 'pause' : 'play'} color={palette.background} size={25} />}
          </Pressable>
          <IconButton icon="next" label="Next song" onPress={() => skip(1)} color={palette.secondary} size={24} style={styles.skipButton} />
        </View>

        <Pressable onPress={openMoment} style={({ pressed }) => [styles.momentButton, pressed && styles.pressed]} accessibilityRole="button" accessibilityLabel={`Add a Moment at ${formatTime(capturePosition())}`}>
          <View style={styles.momentIcon}><IconGlyph icon="bookmark" color={palette.lavenderBright} size={17} /></View>
          <View style={styles.momentButtonCopy}><Text style={styles.momentButtonTitle}>Add a Moment</Text><Text style={styles.momentButtonSubtitle}>Save this point in the mix</Text></View>
          <Text style={styles.momentTimestamp}>{formatTime(capturePosition())}</Text>
        </Pressable>

        {error && <Text style={styles.errorMessage}>{error}</Text>}

        <View style={styles.momentsSection}>
          <View style={styles.momentsHeading}><Text style={styles.momentsTitle}>Moments</Text><Text style={styles.momentsCount}>{moments.length}</Text></View>
          {recentMoments.length ? recentMoments.map((moment) => (
            <Pressable key={moment.id} onPress={() => reopenMoment(moment)} style={({ pressed }) => [styles.momentRow, pressed && styles.pressed]} accessibilityRole="button" accessibilityLabel={`${moment.text || 'Saved moment'}, ${formatTime(moment.timeMs)}`}>
              <View style={styles.momentMarker} />
              <Text style={styles.momentTime}>{formatTime(moment.timeMs)}</Text>
              <Text numberOfLines={1} style={styles.momentNote}>{moment.text || 'Saved moment'}</Text>
              <Text style={styles.momentArrow}>›</Text>
            </Pressable>
          )) : <Text style={styles.noMoments}>Your saved listening points will live here.</Text>}
        </View>
        {queue.length > 1 && <Text style={styles.queueCaption}>SONG {queueIndex + 1} OF {queue.length}</Text>}
      </ScrollView>

      <Modal visible={momentOpen} transparent animationType="slide" onRequestClose={() => setMomentOpen(false)}>
        <KeyboardAvoidingView style={styles.modalRoot} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <Pressable style={styles.scrim} onPress={() => setMomentOpen(false)} />
          <View style={styles.modalCard}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalEyebrow}>LISTENING MOMENT · {formatTime(momentTarget?.timeMs ?? 0)}</Text>
            <Text style={styles.modalTitle}>Keep this point close.</Text>
            <Text style={styles.modalCopy}>This moment is saved to this version of the song.</Text>
            <TextInput
              value={momentText}
              onChangeText={setMomentText}
              placeholder="Add a thought, or leave this blank"
              placeholderTextColor={palette.muted}
              multiline
              maxLength={1000}
              textAlignVertical="top"
              style={styles.noteInput}
              accessibilityLabel="Moment note"
            />
            <View style={styles.modalActions}>
              <Pressable onPress={() => setMomentOpen(false)} style={styles.cancelButton} accessibilityRole="button" accessibilityLabel="Cancel moment"><Text style={styles.cancelText}>Cancel</Text></Pressable>
              <Pressable onPress={() => void saveMoment()} disabled={savingMoment} style={[styles.saveButton, savingMoment && styles.disabled]} accessibilityRole="button" accessibilityLabel="Save Moment">
                {savingMoment ? <ActivityIndicator color={palette.background} /> : <Text style={styles.saveText}>Save Moment</Text>}
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

function formatTime(valueMs: number) {
  if (!Number.isFinite(valueMs) || valueMs < 0) return '0:00';
  const seconds = Math.floor(valueMs / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}` : `${minutes}:${String(remainder).padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: palette.background },
  topBar: { height: 54, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12 },
  nowPlayingTitle: { flex: 1, alignItems: 'center', gap: 3 },
  topLabel: { color: palette.lavender, fontSize: 9, letterSpacing: 2, fontWeight: '700' },
  topProject: { maxWidth: 230, color: palette.muted, fontSize: 10 },
  topSpacer: { width: 44 },
  content: { alignItems: 'center', paddingHorizontal: 23, paddingTop: 11, paddingBottom: 36 },
  artworkWrap: { width: '100%', maxWidth: 340, aspectRatio: 1, position: 'relative', borderRadius: 25, shadowColor: '#07060A', shadowOpacity: 0.55, shadowRadius: 32, shadowOffset: { width: 0, height: 22 }, elevation: 12 },
  cover: { width: '100%', height: '100%', borderRadius: 25 },
  artworkEdge: { ...StyleSheet.absoluteFill, borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)', borderRadius: 25 },
  trackHeading: { width: '100%', maxWidth: 390, flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 25 },
  trackTitleWrap: { flex: 1, gap: 6 },
  trackTitle: { color: palette.text, fontFamily: headingFont, fontSize: 25, letterSpacing: -0.5 },
  trackSubtitle: { color: palette.secondary, fontSize: 12 },
  subtitleDot: { color: palette.lavender },
  localBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, paddingVertical: 6, borderWidth: 1, borderColor: palette.line, borderRadius: 12 },
  localDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: palette.success },
  localText: { color: palette.secondary, fontSize: 8, letterSpacing: 1, fontWeight: '700' },
  scrubber: { width: '100%', maxWidth: 390, marginTop: 16 },
  timeLabels: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 2 },
  timeText: { color: palette.muted, fontSize: 10, fontVariant: ['tabular-nums'] },
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 29, marginTop: 16 },
  skipButton: { width: 54, height: 54 },
  mainPlay: { width: 65, height: 65, alignItems: 'center', justifyContent: 'center', borderRadius: 33, backgroundColor: palette.lavender },
  mainPlayIcon: { width: 65, height: 65 },
  mainPlayPressed: { transform: [{ scale: 0.96 }], opacity: 0.86 },
  momentButton: { width: '100%', maxWidth: 390, minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 11, marginTop: 23, paddingVertical: 10, paddingHorizontal: 10, borderWidth: 1, borderColor: 'rgba(200,184,236,0.22)', borderRadius: 18, backgroundColor: 'rgba(200,184,236,0.08)' },
  momentIcon: { width: 40, height: 40, borderRadius: 13, backgroundColor: 'rgba(200,184,236,0.11)' },
  momentButtonCopy: { flex: 1, gap: 4 },
  momentButtonTitle: { color: palette.text, fontSize: 13, fontWeight: '600' },
  momentButtonSubtitle: { color: palette.muted, fontSize: 10 },
  momentTimestamp: { color: palette.lavenderBright, paddingRight: 5, fontSize: 11, fontVariant: ['tabular-nums'] },
  momentsSection: { width: '100%', maxWidth: 390, marginTop: 30 },
  momentsHeading: { flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom: 10 },
  momentsTitle: { color: palette.text, fontFamily: headingFont, fontSize: 21 },
  momentsCount: { minWidth: 21, color: palette.muted, fontSize: 10, textAlign: 'center' },
  momentRow: { minHeight: 49, flexDirection: 'row', alignItems: 'center', gap: 10, borderTopWidth: 1, borderTopColor: palette.line },
  momentMarker: { width: 3, height: 19, borderRadius: 2, backgroundColor: palette.lavender },
  momentTime: { width: 38, color: palette.lavenderBright, fontSize: 11, fontVariant: ['tabular-nums'] },
  momentNote: { flex: 1, color: palette.secondary, fontSize: 12 },
  momentArrow: { color: palette.muted, fontSize: 21 },
  noMoments: { paddingVertical: 15, color: palette.muted, fontSize: 11, borderTopWidth: 1, borderTopColor: palette.line },
  queueCaption: { marginTop: 20, color: palette.muted, fontSize: 9, letterSpacing: 1.7, fontWeight: '700' },
  errorMessage: { marginTop: 14, color: palette.danger, fontSize: 12 },
  pressed: { opacity: 0.74 },
  disabled: { opacity: 0.5 },
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 36 },
  emptyArtwork: { borderRadius: 28 },
  emptyTitle: { marginTop: 22, color: palette.text, fontFamily: headingFont, fontSize: 25, textAlign: 'center' },
  emptyCopy: { marginTop: 8, color: palette.secondary, fontSize: 13, lineHeight: 20, textAlign: 'center' },
  backButton: { marginTop: 19, paddingVertical: 11, paddingHorizontal: 16, borderRadius: 18, backgroundColor: palette.surfaceRaised },
  backButtonText: { color: palette.text, fontSize: 12, fontWeight: '600' },
  modalRoot: { flex: 1, justifyContent: 'flex-end' },
  scrim: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(6,5,10,0.7)' },
  modalCard: { paddingHorizontal: 22, paddingTop: 12, paddingBottom: 26, borderTopWidth: 1, borderColor: 'rgba(232,222,251,0.2)', borderTopLeftRadius: 28, borderTopRightRadius: 28, backgroundColor: palette.surface },
  modalHandle: { alignSelf: 'center', width: 36, height: 4, marginBottom: 22, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.24)' },
  modalEyebrow: { color: palette.lavender, fontSize: 9, letterSpacing: 1.8, fontWeight: '700' },
  modalTitle: { marginTop: 10, color: palette.text, fontFamily: headingFont, fontSize: 27 },
  modalCopy: { marginTop: 6, color: palette.secondary, fontSize: 12 },
  noteInput: { minHeight: 105, maxHeight: 190, marginTop: 17, padding: 14, borderWidth: 1, borderColor: palette.line, borderRadius: 14, color: palette.text, fontSize: 14, lineHeight: 20, backgroundColor: 'rgba(0,0,0,0.14)' },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 10, marginTop: 16 },
  cancelButton: { paddingVertical: 12, paddingHorizontal: 14 },
  cancelText: { color: palette.secondary, fontSize: 13 },
  saveButton: { minWidth: 122, minHeight: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, borderRadius: 15, backgroundColor: palette.lavender },
  saveText: { color: palette.background, fontSize: 12, fontWeight: '700' },
});
