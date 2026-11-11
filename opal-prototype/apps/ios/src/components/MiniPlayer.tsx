import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Slider from '@react-native-community/slider';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ProjectArtwork } from './ProjectArtwork';
import { IconButton, IconGlyph } from './IconButton';
import { GlassSurface } from './GlassSurface';
import { usePlaybackActions, usePlaybackState } from '../playback/PlaybackProvider';
import { palette } from '../constants/theme';

export function MiniPlayer() {
  const { track, playing, loading, positionMs, durationMs, queueIndex, queue } = usePlaybackState();
  const { toggle, skip, seek } = usePlaybackActions();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  if (!track) return null;

  return (
    <View style={[styles.position, { bottom: Math.max(insets.bottom, 8) + 80 }]}>
      <GlassSurface style={styles.shell}>
        <View style={styles.topRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open Now Playing for ${track.groupTitle || track.title}, ${track.versionName}`}
            onPress={() => router.push('/now-playing')}
            style={({ pressed }) => [styles.trackCapsule, pressed && styles.pressed]}
          >
            <ProjectArtwork project={track} size={40} style={styles.artwork} />
            <View style={styles.copy}>
              <Text numberOfLines={1} style={styles.title}>{track.groupTitle || track.title}</Text>
              <Text numberOfLines={1} style={styles.subtitle}>{track.versionName} · {track.projectTitle}</Text>
            </View>
            <IconGlyph icon="waveform" size={17} color={palette.lavenderBright} />
          </Pressable>

          <View style={styles.controls}>
            <IconButton
              icon="previous"
              label="Previous song"
              onPress={() => skip(-1)}
              disabled={queueIndex < 0}
              size={16}
              color={palette.secondary}
              style={styles.skipButton}
            />
            <IconButton
              icon={playing ? 'pause' : 'play'}
              label={playing ? 'Pause' : loading ? 'Loading audio' : 'Play'}
              onPress={toggle}
              disabled={loading}
              size={17}
              color={palette.text}
              background="rgba(243, 246, 255, 0.19)"
              style={styles.playButton}
            />
            <IconButton
              icon="next"
              label="Next song"
              onPress={() => skip(1)}
              disabled={queueIndex >= queue.length - 1}
              size={16}
              color={palette.secondary}
              style={styles.skipButton}
            />
          </View>
        </View>

        <View style={styles.progressRow}>
          <Text style={styles.time}>{formatTime(positionMs)}</Text>
          <Slider
            style={styles.slider}
            value={durationMs > 0 ? Math.min(positionMs, durationMs) / 1000 : 0}
            minimumValue={0}
            maximumValue={Math.max(durationMs / 1000, 1)}
            disabled={!durationMs || loading}
            minimumTrackTintColor="rgba(249, 250, 255, 0.94)"
            maximumTrackTintColor="rgba(245, 247, 255, 0.28)"
            thumbTintColor="#FFFFFF"
            accessibilityLabel="Playback position"
            onSlidingComplete={(value) => void seek(value * 1000)}
          />
          <Text style={styles.time}>{formatTime(durationMs)}</Text>
        </View>
      </GlassSurface>
    </View>
  );
}

function formatTime(valueMs: number) {
  const seconds = Math.max(0, Math.floor(valueMs / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  position: { position: 'absolute', left: 14, right: 14, zIndex: 11 },
  shell: {
    minHeight: 100,
    paddingHorizontal: 8,
    paddingTop: 8,
    paddingBottom: 2,
    borderRadius: 27,
  },
  topRow: { minHeight: 51, flexDirection: 'row', alignItems: 'center', gap: 5 },
  trackCapsule: {
    flex: 1,
    minWidth: 0,
    height: 50,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(237, 242, 255, 0.17)',
    borderRadius: 17,
    backgroundColor: 'rgba(20, 33, 58, 0.48)',
  },
  artwork: { borderRadius: 12, borderWidth: 1, borderColor: 'rgba(249,250,255,0.23)' },
  copy: { flex: 1, minWidth: 0, gap: 3 },
  title: { color: palette.text, fontSize: 12, fontWeight: '600', letterSpacing: -0.15 },
  subtitle: { color: palette.secondary, fontSize: 9 },
  controls: { flexDirection: 'row', alignItems: 'center', gap: 0 },
  skipButton: { width: 30, height: 42 },
  playButton: { width: 37, height: 37, marginHorizontal: 1 },
  progressRow: { height: 35, flexDirection: 'row', alignItems: 'center', gap: 4 },
  slider: { flex: 1, height: 25 },
  time: { minWidth: 30, color: palette.secondary, fontSize: 9, fontVariant: ['tabular-nums'], textAlign: 'center' },
  pressed: { opacity: 0.82 },
});
