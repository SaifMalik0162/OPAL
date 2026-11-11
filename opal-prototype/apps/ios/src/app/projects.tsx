import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
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

export default function ProjectsScreen() {
  const router = useRouter();
  const { projects, loading } = useLibrary();
  const [query, setQuery] = useState('');
  const [sortByName, setSortByName] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const filteredProjects = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const matches = normalized ? projects.filter((project) => project.title.toLocaleLowerCase().includes(normalized)) : projects;
    return sortByName ? [...matches].sort((left, right) => left.title.localeCompare(right.title)) : matches;
  }, [projects, query, sortByName]);

  const openProject = (project: Project) => router.push({ pathname: '/project/[id]', params: { id: project.id } });
  const createdProject = (id: string) => router.push({ pathname: '/project/[id]', params: { id } });

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

      <View style={styles.titleRow}>
        <View>
          <Text style={styles.eyebrow}>YOUR WORKSPACE</Text>
          <Text style={styles.title}>Projects</Text>
        </View>
        <Pressable onPress={() => setSortByName((current) => !current)} style={styles.sortPill} accessibilityRole="button" accessibilityLabel={`Sort projects by ${sortByName ? 'recently updated' : 'name'}`}>
          <Text style={styles.sortLabel}>{sortByName ? 'Name' : 'Recently updated'}</Text>
          <IconGlyph icon="chevronDown" size={13} color={palette.secondary} />
        </Pressable>
      </View>

      <View style={styles.searchField}>
        <IconGlyph icon="search" size={17} color={palette.secondary} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search projects"
          placeholderTextColor={palette.muted}
          returnKeyType="search"
          clearButtonMode="while-editing"
          style={styles.searchInput}
          accessibilityLabel="Search projects"
        />
      </View>

      <FlatList
        data={filteredProjects}
        keyExtractor={(project) => project.id}
        renderItem={({ item, index }) => <ProjectRow project={item} index={index} onPress={() => openProject(item)} />}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={loading ? (
          <View style={styles.emptyState}><ActivityIndicator color={palette.lavenderBright} /><Text style={styles.emptyCopy}>Opening your projects</Text></View>
        ) : (
          <View style={styles.emptyState}>
            <IconGlyph icon={query ? 'search' : 'folder'} size={30} color={palette.lavender} />
            <Text style={styles.emptyTitle}>{query ? 'No matches yet.' : 'Your projects start here.'}</Text>
            <Text style={styles.emptyCopy}>{query ? 'Try another project name.' : 'Create a project, then import a bounce from Files.'}</Text>
            {!query && <Pressable onPress={() => setCreateOpen(true)} style={styles.newProjectButton} accessibilityRole="button" accessibilityLabel="Create your first project"><IconGlyph icon="add" size={16} color={palette.background} /><Text style={styles.newProjectText}>Create project</Text></Pressable>}
          </View>
        )}
      />

      <CreateProjectSheet visible={createOpen} onClose={() => setCreateOpen(false)} onCreated={createdProject} />
      <BottomTabBar />
      <MiniPlayer />
    </SafeAreaView>
  );
}

function ProjectRow({ project, index, onPress }: { project: Project; index: number; onPress: () => void }) {
  const updated = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(project.updatedAt));
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.projectRow, pressed && styles.pressed]} accessibilityRole="button" accessibilityLabel={`Open ${project.title}`}>
      <ProjectArtwork project={project} size={70} style={styles.projectArtwork} />
      <View style={styles.projectCopy}>
        <Text style={styles.projectEyebrow}>{index === 0 ? 'RECENT PROJECT' : 'LOCAL PROJECT'}</Text>
        <Text style={styles.projectTitle} numberOfLines={1}>{project.title}</Text>
        <Text style={styles.projectMeta}>{project.trackCount} {project.trackCount === 1 ? 'track' : 'tracks'} <Text style={styles.metaDot}>·</Text> Updated {updated}</Text>
      </View>
      <IconGlyph icon="open" size={15} color={palette.muted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: 'transparent' },
  header: { height: 47, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 19 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  brandMark: { width: 33, height: 33 },
  wordmark: { color: palette.text, fontFamily: headingFont, fontSize: 17, letterSpacing: 4.5 },
  createIcon: { width: 38, height: 38, borderWidth: 1, borderColor: 'rgba(241,245,255,0.28)', borderRadius: 20, backgroundColor: 'rgba(205,216,240,0.15)' },
  titleRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 10, marginTop: 21, paddingHorizontal: 22 },
  eyebrow: { color: palette.secondary, fontSize: 9, letterSpacing: 1.8, fontWeight: '700' },
  title: { marginTop: 5, color: palette.text, fontFamily: headingFont, fontSize: 34, letterSpacing: -1.1 },
  sortPill: { minHeight: 34, flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 10, borderWidth: 1, borderColor: 'rgba(237,243,255,0.20)', borderRadius: 18, backgroundColor: 'rgba(217,226,246,0.10)' },
  sortLabel: { color: palette.secondary, fontSize: 10 },
  searchField: { height: 42, flexDirection: 'row', alignItems: 'center', gap: 9, marginHorizontal: 19, marginTop: 16, paddingHorizontal: 13, borderWidth: 1, borderColor: 'rgba(236,242,255,0.23)', borderRadius: 22, backgroundColor: 'rgba(220,229,247,0.10)' },
  searchInput: { flex: 1, minWidth: 0, color: palette.text, fontSize: 12 },
  listContent: { flexGrow: 1, paddingHorizontal: 22, paddingTop: 16, paddingBottom: 164 },
  projectRow: { minHeight: 92, flexDirection: 'row', alignItems: 'center', gap: 13, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(238,244,255,0.25)' },
  projectArtwork: { borderRadius: 15, borderWidth: 1, borderColor: 'rgba(248,249,255,0.2)' },
  projectCopy: { flex: 1, minWidth: 0, gap: 4 },
  projectEyebrow: { color: palette.lavenderBright, fontSize: 8, letterSpacing: 1.1, fontWeight: '600' },
  projectTitle: { color: palette.text, fontFamily: headingFont, fontSize: 19, letterSpacing: -0.3 },
  projectMeta: { color: palette.muted, fontSize: 10 },
  metaDot: { color: palette.lavenderBright },
  emptyState: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28 },
  emptyTitle: { marginTop: 12, color: palette.text, fontFamily: headingFont, fontSize: 23, textAlign: 'center' },
  emptyCopy: { marginTop: 7, color: palette.secondary, fontSize: 12, lineHeight: 18, textAlign: 'center' },
  newProjectButton: { minHeight: 42, flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 18, paddingHorizontal: 16, borderRadius: 22, backgroundColor: 'rgba(239,240,255,0.89)' },
  newProjectText: { color: palette.background, fontSize: 12, fontWeight: '600' },
  pressed: { opacity: 0.7 },
});
