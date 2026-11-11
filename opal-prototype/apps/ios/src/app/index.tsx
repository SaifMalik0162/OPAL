import * as DocumentPicker from 'expo-document-picker';
import { useRouter } from 'expo-router';
import { useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { IconButton, IconGlyph } from '../components/IconButton';
import { AmbientCanvas } from '../components/AmbientCanvas';
import { BottomTabBar } from '../components/BottomTabBar';
import { CreateProjectSheet } from '../components/CreateProjectSheet';
import { MiniPlayer } from '../components/MiniPlayer';
import { ProjectArtwork } from '../components/ProjectArtwork';
import { useLibrary } from '../data/LibraryProvider';
import type { Project } from '../data/models';
import { headingFont, palette } from '../constants/theme';

export default function LibraryScreen() {
  const router = useRouter();
  const { projects, loading, importAudioFiles } = useLibrary();
  const { width } = useWindowDimensions();
  const carouselRef = useRef<FlatList<Project> | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [importing, setImporting] = useState(false);

  const filteredProjects = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return normalized ? projects.filter((project) => project.title.toLocaleLowerCase().includes(normalized)) : projects;
  }, [projects, query]);
  const sleeveWidth = Math.min(252, Math.max(222, width - 82));
  const carouselStep = sleeveWidth + 16;
  const selectedIndex = Math.max(0, filteredProjects.findIndex((project) => project.id === selectedId));
  const selectedProject = filteredProjects[selectedIndex] ?? null;

  const openProject = (project: Project) => router.push({ pathname: '/project/[id]', params: { id: project.id } });

  const updateQuery = (value: string) => {
    setQuery(value);
    const normalized = value.trim().toLocaleLowerCase();
    const firstMatch = normalized ? projects.find((project) => project.title.toLocaleLowerCase().includes(normalized)) : projects[0];
    setSelectedId(firstMatch?.id ?? null);
    carouselRef.current?.scrollToOffset({ offset: 0, animated: false });
  };

  const moveToProject = (index: number) => {
    const nextProject = filteredProjects[index];
    if (!nextProject) return;
    if (nextProject.id === selectedId) {
      openProject(nextProject);
      return;
    }
    setSelectedId(nextProject.id);
    carouselRef.current?.scrollToOffset({ offset: index * carouselStep, animated: true });
  };

  const selectAtScrollEnd = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const index = Math.min(filteredProjects.length - 1, Math.max(0, Math.round(event.nativeEvent.contentOffset.x / carouselStep)));
    const nextProject = filteredProjects[index];
    if (nextProject) setSelectedId(nextProject.id);
  };

  const importAudio = async () => {
    if (!selectedProject) {
      setCreateOpen(true);
      return;
    }
    if (importing) return;
    setImporting(true);
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: 'audio/*', multiple: true, copyToCacheDirectory: true });
      if (result.canceled) return;
      const count = await importAudioFiles(selectedProject.id, result.assets);
      if (count > 0) Alert.alert('Added to project', `${count} ${count === 1 ? 'audio file is' : 'audio files are'} ready to listen to offline.`);
      else Alert.alert('No new audio added', 'Those audio files are already in this project.');
    } catch (error) {
      Alert.alert('Could not import audio', error instanceof Error ? error.message : 'Please try another audio file.');
    } finally {
      setImporting(false);
    }
  };

  const createdProject = (id: string) => {
    setSelectedId(id);
    router.push({ pathname: '/project/[id]', params: { id } });
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <AmbientCanvas />
      <View style={styles.header}>
        <View style={styles.brand}>
          <Image source={require('../../assets/OPAL.icon/Assets/opal-mark.png')} style={styles.brandMark} resizeMode="contain" />
          <Text style={styles.wordmark}>OPAL</Text>
        </View>
        <IconButton icon="add" label="Create a new project" onPress={() => setCreateOpen(true)} style={styles.createIcon} />
      </View>

      <View style={styles.searchField}>
        <IconGlyph icon="search" size={17} color={palette.secondary} />
        <TextInput
          value={query}
          onChangeText={updateQuery}
          placeholder="Search your library"
          placeholderTextColor={palette.muted}
          returnKeyType="search"
          clearButtonMode="while-editing"
          style={styles.searchInput}
          accessibilityLabel="Search projects"
        />
      </View>

      <View style={styles.content}>
        <View style={styles.libraryLabel}>
          <Text style={styles.eyebrow}>LIBRARY</Text>
          <Text style={styles.projectCount}>{filteredProjects.length} {filteredProjects.length === 1 ? 'PROJECT' : 'PROJECTS'}</Text>
        </View>

        {loading ? (
          <View style={styles.loading}><ActivityIndicator color={palette.lavenderBright} /><Text style={styles.loadingText}>Opening your library</Text></View>
        ) : filteredProjects.length ? (
          <>
            <FlatList
              ref={carouselRef}
              horizontal
              data={filteredProjects}
              keyExtractor={(project) => project.id}
              renderItem={({ item, index }) => (
                <SleeveCard
                  project={item}
                  width={sleeveWidth}
                  selected={item.id === selectedProject?.id}
                  side={index < selectedIndex ? 'left' : 'right'}
                  onPress={() => moveToProject(index)}
                />
              )}
              style={[styles.carousel, { height: sleeveWidth + 84 }]}
              contentContainerStyle={{ paddingHorizontal: Math.max(0, (width - carouselStep) / 2) }}
              showsHorizontalScrollIndicator={false}
              snapToInterval={carouselStep}
              decelerationRate="fast"
              disableIntervalMomentum
              onMomentumScrollEnd={selectAtScrollEnd}
              getItemLayout={(_, index) => ({ length: carouselStep, offset: carouselStep * index, index })}
              initialNumToRender={3}
              windowSize={3}
              extraData={`${selectedProject?.id ?? ''}:${sleeveWidth}`}
              accessibilityLabel="Project artwork carousel"
            />
            {selectedProject && (
              <>
                <View style={styles.caption}>
                  <Text style={styles.captionMeta}>{formatTrackCount(selectedProject.trackCount)} <Text style={styles.captionDot}>·</Text> {formatDuration(selectedProject.durationMs)} <Text style={styles.captionArrow}>↗</Text></Text>
                </View>
                <View style={styles.actions}>
                  <Pressable onPress={() => openProject(selectedProject)} style={({ pressed }) => [styles.openButton, pressed && styles.pressed]} accessibilityRole="button" accessibilityLabel={`Open project ${selectedProject.title}`}>
                    <Text style={styles.openText}>Open project</Text>
                    <IconGlyph icon="open" size={14} color={palette.background} />
                  </Pressable>
                  <Pressable onPress={() => void importAudio()} disabled={importing} style={({ pressed }) => [styles.importButton, pressed && styles.pressed, importing && styles.disabled]} accessibilityRole="button" accessibilityLabel="Import audio into selected project">
                    {importing ? <ActivityIndicator size="small" color={palette.text} /> : <IconGlyph icon="add" size={16} color={palette.text} />}
                    <Text style={styles.importText}>{importing ? 'Adding' : 'Add songs'}</Text>
                  </Pressable>
                </View>
              </>
            )}
          </>
        ) : projects.length ? (
          <View style={styles.noResults}>
            <IconGlyph icon="search" size={25} color={palette.lavender} />
            <Text style={styles.emptyTitle}>No matches yet.</Text>
            <Text style={styles.emptyCopy}>Try another project name.</Text>
          </View>
        ) : (
          <View style={styles.emptyState}>
            <ProjectArtwork project={{ artworkIndex: 1 }} size={116} style={styles.emptyArtwork} />
            <Text style={styles.emptyEyebrow}>A PLACE FOR THE NEXT VERSION</Text>
            <Text style={styles.emptyTitle}>Start with a project.</Text>
            <Text style={styles.emptyCopy}>Bring a bounce in from Files, then keep the listening notes and versions together.</Text>
            <Pressable onPress={() => setCreateOpen(true)} style={({ pressed }) => [styles.openButton, styles.emptyAction, pressed && styles.pressed]} accessibilityRole="button" accessibilityLabel="Create your first project">
              <IconGlyph icon="add" size={16} color={palette.background} />
              <Text style={styles.openText}>Create project</Text>
            </Pressable>
          </View>
        )}
      </View>

      <CreateProjectSheet visible={createOpen} onClose={() => setCreateOpen(false)} onCreated={createdProject} />
      <BottomTabBar />
      <MiniPlayer />
    </SafeAreaView>
  );
}

function SleeveCard({ project, width, selected, side, onPress }: { project: Project; width: number; selected: boolean; side: 'left' | 'right'; onPress: () => void }) {
  const imageSize = width - 16;
  return (
    <View style={[styles.carouselItem, { width: width + 16 }]}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`${selected ? 'Open' : 'Select'} project ${project.title}`}
        style={({ pressed }) => [
          styles.sleeve,
          { width, transform: [{ scale: selected ? 1 : 0.84 }, { rotate: selected ? '0deg' : side === 'left' ? '-8deg' : '8deg' }] },
          selected && styles.sleeveSelected,
          pressed && styles.pressed,
        ]}
      >
        <ProjectArtwork project={project} size={imageSize} style={styles.sleeveArtwork} />
        <View style={styles.sleeveMeta}>
          <Text numberOfLines={1} style={styles.sleeveTitle}>{project.title}</Text>
          <Text style={styles.sleeveSubtitle}>OPAL PROJECT</Text>
        </View>
      </Pressable>
    </View>
  );
}

function formatTrackCount(count: number) {
  return `${count} ${count === 1 ? 'track' : 'tracks'}`;
}

function formatDuration(durationMs: number) {
  const totalMinutes = Math.max(0, Math.round(durationMs / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours ? `${hours} hr ${minutes} min` : `${totalMinutes} min`;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: 'transparent' },
  header: { height: 47, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 19 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  brandMark: { width: 33, height: 33 },
  wordmark: { color: palette.text, fontFamily: headingFont, fontSize: 17, letterSpacing: 4.5 },
  createIcon: { width: 38, height: 38, borderWidth: 1, borderColor: 'rgba(241,245,255,0.28)', borderRadius: 20, backgroundColor: 'rgba(205,216,240,0.15)' },
  searchField: { height: 42, flexDirection: 'row', alignItems: 'center', gap: 9, marginHorizontal: 19, marginTop: 8, paddingHorizontal: 13, borderWidth: 1, borderColor: 'rgba(236,242,255,0.23)', borderRadius: 22, backgroundColor: 'rgba(220,229,247,0.10)' },
  searchInput: { flex: 1, minWidth: 0, color: palette.text, fontSize: 12 },
  content: { flex: 1, paddingTop: 17, paddingBottom: 162 },
  libraryLabel: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 22, marginBottom: 9 },
  eyebrow: { color: palette.secondary, fontSize: 9, letterSpacing: 1.9, fontWeight: '700' },
  projectCount: { color: palette.muted, fontSize: 8, letterSpacing: 1.2, fontWeight: '600' },
  carousel: { flexGrow: 0, overflow: 'visible' },
  carouselItem: { alignItems: 'center', justifyContent: 'flex-start', paddingTop: 1 },
  sleeve: { alignItems: 'center', padding: 7, borderWidth: 1, borderColor: 'rgba(239,244,255,0.36)', borderRadius: 24, backgroundColor: 'rgba(132,150,187,0.58)', shadowColor: '#0C1930', shadowOpacity: 0.32, shadowRadius: 22, shadowOffset: { width: 0, height: 12 }, elevation: 8 },
  sleeveSelected: { borderColor: 'rgba(246,248,255,0.68)', shadowOpacity: 0.4, shadowRadius: 26 },
  sleeveArtwork: { borderRadius: 17, borderWidth: 1, borderColor: 'rgba(250,251,255,0.18)' },
  sleeveMeta: { width: '100%', height: 55, alignItems: 'center', justifyContent: 'center', gap: 3, paddingHorizontal: 8 },
  sleeveTitle: { maxWidth: '100%', color: palette.text, fontFamily: headingFont, fontSize: 16, letterSpacing: -0.2 },
  sleeveSubtitle: { color: 'rgba(247,248,255,0.72)', fontSize: 8, letterSpacing: 1.1, fontWeight: '500' },
  caption: { alignItems: 'center', marginTop: 8, paddingHorizontal: 24 },
  captionMeta: { color: palette.secondary, fontSize: 12, fontVariant: ['tabular-nums'] },
  captionDot: { color: palette.lavenderBright },
  captionArrow: { marginLeft: 4, color: palette.secondary, fontSize: 14 },
  actions: { flexDirection: 'row', justifyContent: 'center', gap: 9, marginTop: 14, paddingHorizontal: 20 },
  openButton: { minHeight: 42, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 16, borderRadius: 23, backgroundColor: 'rgba(239,240,255,0.89)' },
  openText: { color: palette.background, fontSize: 12, fontWeight: '600' },
  importButton: { minHeight: 42, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, paddingHorizontal: 15, borderWidth: 1, borderColor: 'rgba(238,243,255,0.28)', borderRadius: 23, backgroundColor: 'rgba(225,233,249,0.12)' },
  importText: { color: palette.text, fontSize: 12, fontWeight: '500' },
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', marginHorizontal: 23, marginTop: -25, padding: 23, borderWidth: 1, borderColor: 'rgba(239,244,255,0.22)', borderRadius: 26, backgroundColor: 'rgba(127,145,180,0.20)' },
  emptyArtwork: { borderRadius: 24 },
  emptyEyebrow: { marginTop: 22, color: palette.lavenderBright, fontSize: 9, letterSpacing: 1.6, fontWeight: '700', textAlign: 'center' },
  emptyTitle: { marginTop: 9, color: palette.text, fontFamily: headingFont, fontSize: 27, letterSpacing: -0.6, textAlign: 'center' },
  emptyCopy: { maxWidth: 270, marginTop: 8, color: palette.secondary, fontSize: 13, lineHeight: 19, textAlign: 'center' },
  emptyAction: { marginTop: 19 },
  noResults: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, marginTop: -40 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, marginTop: -40 },
  loadingText: { color: palette.muted, fontSize: 12 },
  pressed: { opacity: 0.76, transform: [{ scale: 0.98 }] },
  disabled: { opacity: 0.6 },
});
