import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ProjectArtwork } from './ProjectArtwork';
import { IconButton } from './IconButton';
import { usePlaybackActions, usePlaybackState } from '../playback/PlaybackProvider';
import { palette } from '../constants/theme';

export function MiniPlayer() {
  const { track, playing, loading, positionMs, durationMs } = usePlaybackState();
  const { toggle } = usePlaybackActions();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  if (!track) return null;
  const progress = durationMs > 0 ? Math.min(1, positionMs / durationMs) : 0;

  return (
    <View style={[styles.position, { bottom: Math.max(insets.bottom, 8) + 8 }]}>
      <View style={styles.shell}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Now playing: ${track.title}`}
          onPress={() => router.push('/now-playing')}
          style={({ pressed }) => [styles.trackButton, pressed && styles.pressed]}
        >
          <ProjectArtwork project={track} size={46} style={styles.artwork} />
          <View style={styles.copy}>
            <Text numberOfLines={1} style={styles.title}>{track.title}</Text>
            <Text numberOfLines={1} style={styles.subtitle}>{track.projectTitle}</Text>
          </View>
        </Pressable>
        <IconButton
          icon={playing ? 'pause' : 'play'}
          label={playing ? 'Pause' : loading ? 'Loading audio' : 'Play'}
          onPress={toggle}
          disabled={loading}
          size={20}
          color={palette.text}
          background="rgba(240, 233, 255, 0.11)"
          style={styles.playButton}
        />
        <View pointerEvents="none" style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  position: { position: 'absolute', left: 14, right: 14, zIndex: 10 },
  shell: {
    minHeight: 70,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 11,
    borderWidth: 1,
    borderColor: 'rgba(236, 227, 250, 0.2)',
    borderRadius: 23,
    backgroundColor: 'rgba(39, 35, 52, 0.97)',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
    elevation: 12,
  },
  trackButton: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 8 },
  artwork: { borderRadius: 13 },
  copy: { flex: 1, minWidth: 0, gap: 3 },
  title: { color: palette.text, fontSize: 14, fontWeight: '600', letterSpacing: -0.2 },
  subtitle: { color: palette.secondary, fontSize: 12 },
  playButton: { width: 42, height: 42, marginLeft: 6 },
  progressTrack: { position: 'absolute', bottom: 0, left: 17, right: 17, height: 2, overflow: 'hidden', borderBottomLeftRadius: 22, borderBottomRightRadius: 22, backgroundColor: 'rgba(255,255,255,0.08)' },
  progressFill: { height: 2, backgroundColor: palette.lavenderBright },
  pressed: { opacity: 0.82 },
});
