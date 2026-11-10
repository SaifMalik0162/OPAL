import { useRouter } from 'expo-router';
import { useState } from 'react';
import {
  Alert,
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { ProjectArtwork } from '../components/ProjectArtwork';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLibrary } from '../data/LibraryProvider';
import type { Project } from '../data/models';
import { headingFont, palette } from '../constants/theme';

export default function LibraryScreen() {
  const router = useRouter();
  const { projects, loading, createProject } = useLibrary();
  const [createOpen, setCreateOpen] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [creating, setCreating] = useState(false);

  const saveProject = async () => {
    if (!projectName.trim() || creating) return;
    setCreating(true);
    try {
      const id = await createProject(projectName);
      setProjectName('');
      setCreateOpen(false);
      router.push({ pathname: '/project/[id]', params: { id } });
    } catch (error) {
      setCreateOpen(false);
      Alert.alert('Could not create project', error instanceof Error ? error.message : 'Please try again.');
    } finally {
      setCreating(false);
    }
  };

  const openProject = (project: Project) => router.push({ pathname: '/project/[id]', params: { id: project.id } });

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <FlatList
        data={projects}
        keyExtractor={(project) => project.id}
        renderItem={({ item, index }) => <ProjectRow project={item} index={index} onPress={() => openProject(item)} />}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={
          <View>
            <View style={styles.topLine}>
              <View style={styles.brand}>
                <View style={styles.brandMark}><View style={styles.brandDot} /></View>
                <Text style={styles.wordmark}>OPAL</Text>
              </View>
              <View style={styles.devicePill}><View style={styles.deviceDot} /><Text style={styles.deviceText}>{Platform.OS === 'ios' ? 'ON THIS IPHONE' : 'ON THIS DEVICE'}</Text></View>
            </View>

            <View style={styles.headingRow}>
              <View style={styles.headingCopy}>
                <Text style={styles.eyebrow}>YOUR LISTENING ROOM</Text>
                <Text style={styles.heading}>Projects</Text>
              </View>
              <Pressable onPress={() => setCreateOpen(true)} style={({ pressed }) => [styles.createButton, pressed && styles.pressed]} accessibilityRole="button" accessibilityLabel="Create project">
                <Text style={styles.createPlus}>＋</Text>
                <Text style={styles.createText}>New project</Text>
              </Pressable>
            </View>

            <Text style={styles.intro}>A private space for the records you are shaping.</Text>
          </View>
        }
        ListEmptyComponent={
          loading ? (
            <View style={styles.loading}><ActivityIndicator color={palette.lavender} /><Text style={styles.loadingText}>Opening your library</Text></View>
          ) : (
            <View style={styles.emptyCard}>
              <ProjectArtwork project={{ artworkIndex: 0 }} size={76} style={styles.emptyArtwork} />
              <Text style={styles.emptyEyebrow}>MADE FOR THE IN-BETWEEN</Text>
              <Text style={styles.emptyTitle}>A little room to listen.</Text>
              <Text style={styles.emptyDescription}>Bring a song into OPAL, take it offline, and save the exact moments you want to revisit.</Text>
              <Pressable onPress={() => setCreateOpen(true)} style={({ pressed }) => [styles.emptyAction, pressed && styles.pressed]} accessibilityRole="button" accessibilityLabel="Create project">
                <Text style={styles.emptyActionText}>Create your first project</Text>
              </Pressable>
              <Text style={styles.localNote}>Your library stays on this device.</Text>
            </View>
          )
        }
        ListFooterComponent={projects.length ? <Text style={styles.footerNote}>Your music and notes are stored on this device.</Text> : undefined}
        showsVerticalScrollIndicator={false}
      />

      <Modal visible={createOpen} transparent animationType="fade" onRequestClose={() => setCreateOpen(false)}>
        <KeyboardAvoidingView style={styles.modalRoot} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <Pressable style={styles.scrim} onPress={() => setCreateOpen(false)} />
          <View style={styles.modalCard}>
            <Text style={styles.modalEyebrow}>A NEW LISTENING ROOM</Text>
            <Text style={styles.modalTitle}>Name this project</Text>
            <TextInput
              autoFocus
              value={projectName}
              onChangeText={setProjectName}
              onSubmitEditing={() => void saveProject()}
              returnKeyType="done"
              placeholder="For example, Blue Hour"
              placeholderTextColor={palette.muted}
              maxLength={80}
              style={styles.input}
              accessibilityLabel="Project name"
            />
            <View style={styles.modalActions}>
              <Pressable onPress={() => setCreateOpen(false)} style={styles.cancelButton} accessibilityRole="button" accessibilityLabel="Cancel project creation"><Text style={styles.cancelText}>Cancel</Text></Pressable>
              <Pressable disabled={!projectName.trim() || creating} onPress={() => void saveProject()} style={[styles.saveButton, (!projectName.trim() || creating) && styles.disabled]} accessibilityRole="button" accessibilityLabel="Create project">
                {creating ? <ActivityIndicator color={palette.background} /> : <Text style={styles.saveText}>Create project</Text>}
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

function ProjectRow({ project, index, onPress }: { project: Project; index: number; onPress: () => void }) {
  const latest = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(project.updatedAt));
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.projectRow, pressed && styles.projectPressed]} accessibilityRole="button" accessibilityLabel={`Open ${project.title}`}>
      <ProjectArtwork project={project} size={78} style={styles.rowArtwork} />
      <View style={styles.projectCopy}>
        <Text style={styles.projectEyebrow}>{index === 0 ? 'RECENT PROJECT' : 'LOCAL PROJECT'}</Text>
        <Text style={styles.projectTitle} numberOfLines={1}>{project.title}</Text>
        <Text style={styles.projectMeta}>{project.trackCount === 1 ? '1 song' : `${project.trackCount} songs`} <Text style={styles.metaDot}>·</Text> Updated {latest}</Text>
      </View>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: palette.background },
  listContent: { flexGrow: 1, paddingHorizontal: 22, paddingTop: 12, paddingBottom: 150 },
  topLine: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  brandMark: { width: 23, height: 23, borderWidth: 1.2, borderColor: 'rgba(225,212,250,0.78)', borderRadius: 9, alignItems: 'center', justifyContent: 'center', transform: [{ rotate: '45deg' }] },
  brandDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: palette.lavenderBright },
  wordmark: { color: palette.text, fontSize: 13, letterSpacing: 4, fontWeight: '600' },
  devicePill: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingVertical: 7, paddingHorizontal: 10, borderWidth: 1, borderColor: palette.line, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.025)' },
  deviceDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: palette.success },
  deviceText: { color: palette.secondary, fontSize: 9, letterSpacing: 1.1, fontWeight: '600' },
  headingRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, marginTop: 42 },
  headingCopy: { flex: 1 },
  eyebrow: { color: palette.lavender, fontSize: 10, fontWeight: '600', letterSpacing: 2.1 },
  heading: { marginTop: 7, color: palette.text, fontFamily: headingFont, fontSize: 42, letterSpacing: -1.6 },
  intro: { marginTop: 9, marginBottom: 25, color: palette.secondary, fontSize: 14, lineHeight: 21 },
  createButton: { minHeight: 42, flexDirection: 'row', alignItems: 'center', paddingRight: 14, paddingLeft: 4, borderRadius: 24, backgroundColor: palette.lavender, gap: 4 },
  createPlus: { width: 35, height: 35, color: palette.background, fontSize: 25, lineHeight: 34, textAlign: 'center' },
  createText: { color: palette.background, fontSize: 12, fontWeight: '700' },
  projectRow: { minHeight: 104, flexDirection: 'row', alignItems: 'center', gap: 15, paddingVertical: 12, borderTopWidth: 1, borderTopColor: palette.line },
  projectPressed: { opacity: 0.7 },
  rowArtwork: { borderRadius: 15 },
  projectCopy: { flex: 1, minWidth: 0, gap: 5 },
  projectEyebrow: { color: palette.lavender, fontSize: 8, letterSpacing: 1.4, fontWeight: '600' },
  projectTitle: { color: palette.text, fontFamily: headingFont, fontSize: 20, letterSpacing: -0.4 },
  projectMeta: { color: palette.muted, fontSize: 11 },
  metaDot: { color: palette.lavender, paddingHorizontal: 4 },
  chevron: { color: palette.muted, fontSize: 26, paddingHorizontal: 3 },
  emptyCard: { alignItems: 'flex-start', paddingVertical: 27, paddingHorizontal: 23, borderWidth: 1, borderColor: palette.line, borderRadius: 24, backgroundColor: palette.backgroundSoft },
  emptyArtwork: { borderRadius: 23, marginBottom: 24 },
  emptyEyebrow: { color: palette.lavender, fontSize: 9, letterSpacing: 1.9, fontWeight: '700' },
  emptyTitle: { marginTop: 10, color: palette.text, fontFamily: headingFont, fontSize: 27, letterSpacing: -0.8 },
  emptyDescription: { marginTop: 9, color: palette.secondary, fontSize: 14, lineHeight: 21 },
  emptyAction: { marginTop: 20, paddingVertical: 12, paddingHorizontal: 17, borderRadius: 22, backgroundColor: palette.lavender },
  emptyActionText: { color: palette.background, fontSize: 12, fontWeight: '700' },
  localNote: { marginTop: 16, color: palette.muted, fontSize: 11 },
  footerNote: { marginTop: 20, color: palette.muted, fontSize: 11, textAlign: 'center' },
  loading: { minHeight: 220, alignItems: 'center', justifyContent: 'center', gap: 12 },
  loadingText: { color: palette.muted, fontSize: 12 },
  modalRoot: { flex: 1, justifyContent: 'center', paddingHorizontal: 20 },
  scrim: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(7,6,10,0.74)' },
  modalCard: { padding: 23, borderWidth: 1, borderColor: 'rgba(232,222,251,0.2)', borderRadius: 24, backgroundColor: palette.surface },
  modalEyebrow: { color: palette.lavender, fontSize: 9, letterSpacing: 1.8, fontWeight: '700' },
  modalTitle: { marginTop: 10, color: palette.text, fontFamily: headingFont, fontSize: 26 },
  input: { marginTop: 18, paddingHorizontal: 14, paddingVertical: 13, borderWidth: 1, borderColor: palette.line, borderRadius: 13, color: palette.text, fontSize: 15, backgroundColor: 'rgba(0,0,0,0.12)' },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 10, marginTop: 18 },
  cancelButton: { paddingVertical: 12, paddingHorizontal: 14 },
  cancelText: { color: palette.secondary, fontSize: 13 },
  saveButton: { minWidth: 122, minHeight: 42, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14, borderRadius: 14, backgroundColor: palette.lavender },
  saveText: { color: palette.background, fontSize: 12, fontWeight: '700' },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.76 },
});
