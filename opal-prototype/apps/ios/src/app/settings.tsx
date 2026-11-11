import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import { useSQLiteContext } from 'expo-sqlite';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AmbientCanvas } from '../components/AmbientCanvas';
import { BottomTabBar } from '../components/BottomTabBar';
import { IconGlyph } from '../components/IconButton';
import { MiniPlayer } from '../components/MiniPlayer';
import { useLibrary } from '../data/LibraryProvider';
import { headingFont, palette } from '../constants/theme';
import { usePlaybackActions, usePlaybackState } from '../playback/PlaybackProvider';

const supportedPackageVersion = 1;
const archiveExtension = '.opalproject';

type UpgradeStatus = { checkedAt: number; schemaVersion: number; integrity: string; foreignKeyIssues: number };

export default function SettingsScreen() {
  const db = useSQLiteContext();
  const router = useRouter();
  const { deleteProject, getStorageUsage, importProjectPackage, projects } = useLibrary();
  const { track: playingTrack } = usePlaybackState();
  const { stop } = usePlaybackActions();
  const [storage, setStorage] = useState<Awaited<ReturnType<typeof getStorageUsage>> | null>(null);
  const [loadingStorage, setLoadingStorage] = useState(false);
  const [importing, setImporting] = useState(false);
  const [checkingUpgrade, setCheckingUpgrade] = useState(false);
  const [exportingDiagnostics, setExportingDiagnostics] = useState(false);
  const [upgradeStatus, setUpgradeStatus] = useState<UpgradeStatus | null>(null);
  const [storageError, setStorageError] = useState('');

  const appVersion = Constants.expoConfig?.version ?? '0.1.0';
  const projectCount = projects.length;
  const refreshStorage = useCallback(async () => {
    setLoadingStorage(true);
    setStorageError('');
    try {
      setStorage(await getStorageUsage());
    } catch {
      setStorageError('Storage details could not be read. Try again.');
    } finally {
      setLoadingStorage(false);
    }
  }, [getStorageUsage]);

  useEffect(() => {
    let mounted = true;
    void getStorageUsage().then((nextStorage) => {
      if (mounted) setStorage(nextStorage);
    }).catch(() => {
      if (mounted) setStorageError('Storage details could not be read. Try again.');
    });
    return () => { mounted = false; };
  }, [getStorageUsage]);

  const importPackage = async () => {
    if (importing) return;
    setImporting(true);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        multiple: false,
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (!asset?.name.toLowerCase().endsWith(archiveExtension)) {
        throw new Error('Choose a .opalproject file exported from OPAL Desktop.');
      }
      const status = await importProjectPackage(new File(asset.uri));
      if (status === 'alreadyImported') {
        Alert.alert('Already in your library', 'This exact OPAL project snapshot is already saved on this iPhone.');
      } else {
        Alert.alert('Project ready offline', 'The project, mix versions, artwork, notes, and moments have been imported.');
        router.navigate('/projects');
      }
      await refreshStorage();
    } catch (error) {
      Alert.alert('Could not import project', error instanceof Error ? error.message : 'Check the project file and try again.');
    } finally {
      setImporting(false);
    }
  };

  const checkUpgrade = async () => {
    setCheckingUpgrade(true);
    try {
      const [schema, integrity, foreignKeys] = await Promise.all([
        db.getFirstAsync<{ user_version: number }>('PRAGMA user_version'),
        db.getFirstAsync<{ integrity_check: string }>('PRAGMA integrity_check'),
        db.getAllAsync<{ table: string }>('PRAGMA foreign_key_check'),
      ]);
      setUpgradeStatus({
        checkedAt: Date.now(),
        schemaVersion: schema?.user_version ?? 0,
        integrity: integrity?.integrity_check ?? 'unknown',
        foreignKeyIssues: foreignKeys.length,
      });
    } catch {
      setUpgradeStatus({ checkedAt: Date.now(), schemaVersion: 0, integrity: 'unavailable', foreignKeyIssues: -1 });
    } finally {
      setCheckingUpgrade(false);
    }
  };

  const requestDiagnostics = () => {
    Alert.alert(
      'Share diagnostics?',
      'The report contains OPAL version, device OS and model, database health, and item counts. It does not include project names, audio, filenames, notes, or storage paths.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Continue', onPress: () => { void exportDiagnostics(); } },
      ],
    );
  };

  const exportDiagnostics = async () => {
    if (exportingDiagnostics) return;
    setExportingDiagnostics(true);
    try {
      const [usage, schema, integrity, foreignKeys, trackCount, momentCount] = await Promise.all([
        getStorageUsage(),
        db.getFirstAsync<{ user_version: number }>('PRAGMA user_version'),
        db.getFirstAsync<{ integrity_check: string }>('PRAGMA integrity_check'),
        db.getAllAsync<{ table: string }>('PRAGMA foreign_key_check'),
        db.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM tracks'),
        db.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM moments'),
      ]);
      const report = {
        format: 'opal-diagnostics',
        formatVersion: 1,
        createdAt: new Date().toISOString(),
        appVersion,
        platform: 'iOS',
        osVersion: Device.osVersion ?? 'unknown',
        deviceModel: Device.modelName ?? 'unknown',
        database: {
          schemaVersion: schema?.user_version ?? 0,
          integrity: integrity?.integrity_check ?? 'unknown',
          foreignKeyIssueCount: foreignKeys.length,
          projectCount: usage.projects.length,
          trackCount: trackCount?.count ?? 0,
          momentCount: momentCount?.count ?? 0,
          managedAudioBytes: usage.audioBytes,
          artworkBytes: usage.artworkBytes,
          databaseBytes: usage.databaseBytes,
        },
        supportedProjectPackageVersion: supportedPackageVersion,
      };
      const exportFile = new File(Paths.cache, 'OPAL-diagnostics.json');
      if (exportFile.exists) exportFile.delete();
      exportFile.create({ intermediates: true });
      await exportFile.write(JSON.stringify(report, null, 2));
      await Share.share({ title: 'OPAL diagnostics', url: exportFile.uri });
    } catch {
      Alert.alert('Could not export diagnostics', 'Please try again in a moment.');
    } finally {
      setExportingDiagnostics(false);
    }
  };

  const confirmDeleteProject = (projectId: string, title: string) => {
    Alert.alert(
      'Delete this local project?',
      `“${title}” and its offline audio, notes, and moments will be removed from this iPhone. This does not delete the desktop project.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete project', style: 'destructive', onPress: () => {
          void (async () => {
            if (playingTrack?.projectId === projectId) await stop();
            await deleteProject(projectId);
            await refreshStorage();
          })().catch(() => Alert.alert('Could not delete project', 'The local project could not be removed. Try again.'));
        } },
      ],
    );
  };

  const runUpgradeCheck = () => { void checkUpgrade(); };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <AmbientCanvas />
      <View style={styles.header}><Text style={styles.eyebrow}>OPAL</Text><Text style={styles.title}>Settings</Text></View>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.introCard}>
          <View style={styles.introIcon}><IconGlyph icon="import" size={20} color={palette.lavenderBright} /></View>
          <View style={styles.introCopy}><Text style={styles.cardTitle}>Bring a project from desktop</Text><Text style={styles.cardCopy}>Import one OPAL package and keep every mix ready offline on this iPhone.</Text></View>
          <Pressable onPress={() => void importPackage()} disabled={importing} style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed, importing && styles.disabled]} accessibilityRole="button" accessibilityLabel={importing ? 'Importing OPAL project' : 'Import OPAL project package'}>
            {importing ? <ActivityIndicator color={palette.background} /> : <Text style={styles.primaryButtonText}>Import project</Text>}
          </Pressable>
          <Text style={styles.transferHint}>Choose a .opalproject file from Files or AirDrop. No account is needed.</Text>
        </View>

        <View style={styles.sectionHeading}><Text style={styles.sectionTitle}>On this iPhone</Text><Pressable onPress={() => void refreshStorage()} accessibilityRole="button" accessibilityLabel="Refresh storage usage"><IconGlyph icon="refresh" size={17} color={palette.secondary} /></Pressable></View>
        <View style={styles.storageCard}>
          <View style={styles.storageTotalRow}>
            <View><Text style={styles.metricLabel}>PROJECTS</Text><Text style={styles.storageTotal}>{storage ? formatBytes(storage.audioBytes + storage.artworkBytes + storage.databaseBytes) : '—'}</Text></View>
            {loadingStorage && <ActivityIndicator color={palette.lavenderBright} />}
          </View>
          <Text style={styles.cardCopy}>{projectCount} {projectCount === 1 ? 'project' : 'projects'} · {formatBytes(storage?.audioBytes ?? 0)} offline audio</Text>
          {storageError ? <Text style={styles.error}>{storageError}</Text> : null}
          {storage?.projects.map((project) => (
            <View key={project.id} style={styles.storageProject}>
              <View style={styles.storageProjectCopy}><Text numberOfLines={1} style={styles.storageProjectTitle}>{project.title}</Text><Text style={styles.storageProjectMeta}>{project.trackCount} {project.trackCount === 1 ? 'mix' : 'mixes'} · {formatBytes(project.audioBytes + project.artworkBytes)}</Text></View>
              <Pressable onPress={() => confirmDeleteProject(project.id, project.title)} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Remove ${project.title} and its offline files`} style={styles.deleteButton}><IconGlyph icon="trash" size={16} color={palette.danger} /></Pressable>
            </View>
          ))}
          {!storage && !loadingStorage && <Pressable onPress={() => void refreshStorage()} style={styles.secondaryButton} accessibilityRole="button" accessibilityLabel="Load storage usage"><Text style={styles.secondaryButtonText}>View storage usage</Text></Pressable>}
        </View>

        <View style={styles.sectionHeading}><Text style={styles.sectionTitle}>App & library updates</Text></View>
        <View style={styles.infoCard}>
          <InfoRow label="OPAL app" value={appVersion} />
          <InfoRow label="Project package support" value={`Version ${supportedPackageVersion}`} />
          {upgradeStatus && <>
            <InfoRow label="Local library schema" value={`Version ${upgradeStatus.schemaVersion}`} />
            <InfoRow label="Database integrity" value={upgradeStatus.integrity === 'ok' && upgradeStatus.foreignKeyIssues === 0 ? 'Healthy' : 'Needs attention'} />
            <Text style={styles.checkedAt}>Checked {new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(upgradeStatus.checkedAt))}</Text>
          </>}
          <Pressable onPress={runUpgradeCheck} disabled={checkingUpgrade} style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed, checkingUpgrade && styles.disabled]} accessibilityRole="button" accessibilityLabel="Check OPAL library upgrade compatibility">
            {checkingUpgrade ? <ActivityIndicator color={palette.text} /> : <Text style={styles.secondaryButtonText}>Check library compatibility</Text>}
          </Pressable>
          <Text style={styles.cardFootnote}>OPAL checks local migrations and database health here. App updates will arrive through TestFlight when the beta is available.</Text>
        </View>

        <View style={styles.sectionHeading}><Text style={styles.sectionTitle}>Help improve OPAL</Text></View>
        <View style={styles.infoCard}>
          <Text style={styles.cardCopy}>Share a private, optional diagnostics file if you need help with a beta build.</Text>
          <Pressable onPress={requestDiagnostics} disabled={exportingDiagnostics} style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed, exportingDiagnostics && styles.disabled]} accessibilityRole="button" accessibilityLabel="Review privacy details and export diagnostics">
            {exportingDiagnostics ? <ActivityIndicator color={palette.text} /> : <Text style={styles.secondaryButtonText}>Export diagnostics</Text>}
          </Pressable>
          <Text style={styles.cardFootnote}>Project names, filenames, audio, notes, and storage paths stay out of the report.</Text>
        </View>
        <View style={styles.accountNote}><Text style={styles.accountNoteTitle}>Local by design</Text><Text style={styles.accountNoteCopy}>Projects stay on your devices. One-time transfers use OPAL packages; account-based sync is a separate, opt-in feature planned for later.</Text></View>
      </ScrollView>
      <BottomTabBar />
      <MiniPlayer />
    </SafeAreaView>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return <View style={styles.infoRow}><Text style={styles.infoLabel}>{label}</Text><Text style={styles.infoValue}>{value}</Text></View>;
}

function formatBytes(bytes: number) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: 'transparent' },
  header: { paddingHorizontal: 23, paddingTop: 13, paddingBottom: 5 },
  eyebrow: { color: palette.lavender, fontSize: 9, letterSpacing: 2, fontWeight: '700' },
  title: { marginTop: 6, color: palette.text, fontFamily: headingFont, fontSize: 33, letterSpacing: -0.7 },
  content: { paddingHorizontal: 20, paddingTop: 15, paddingBottom: 180 },
  introCard: { padding: 17, borderWidth: 1, borderColor: 'rgba(231,240,255,0.21)', borderRadius: 22, backgroundColor: 'rgba(206,220,247,0.12)' },
  introIcon: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 14, backgroundColor: 'rgba(213,225,247,0.14)' },
  introCopy: { marginTop: 13 },
  cardTitle: { color: palette.text, fontFamily: headingFont, fontSize: 18 },
  cardCopy: { marginTop: 6, color: palette.secondary, fontSize: 11, lineHeight: 17 },
  primaryButton: { minHeight: 42, alignItems: 'center', justifyContent: 'center', marginTop: 16, borderRadius: 15, backgroundColor: palette.lavenderBright },
  primaryButtonText: { color: palette.background, fontSize: 12, fontWeight: '700' },
  transferHint: { marginTop: 10, color: palette.muted, fontSize: 9, lineHeight: 14, textAlign: 'center' },
  sectionHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 25, marginBottom: 9, paddingHorizontal: 2 },
  sectionTitle: { color: palette.text, fontFamily: headingFont, fontSize: 20 },
  storageCard: { paddingHorizontal: 16, paddingVertical: 15, borderWidth: 1, borderColor: 'rgba(231,240,255,0.18)', borderRadius: 20, backgroundColor: 'rgba(206,220,247,0.09)' },
  storageTotalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  metricLabel: { color: palette.muted, fontSize: 8, letterSpacing: 1.7, fontWeight: '700' },
  storageTotal: { marginTop: 4, color: palette.text, fontFamily: headingFont, fontSize: 25 },
  storageProject: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.line },
  storageProjectCopy: { flex: 1, minWidth: 0 },
  storageProjectTitle: { color: palette.text, fontSize: 12, fontWeight: '600' },
  storageProjectMeta: { marginTop: 4, color: palette.muted, fontSize: 9 },
  deleteButton: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center', borderRadius: 13, backgroundColor: 'rgba(255,110,132,0.09)' },
  infoCard: { paddingHorizontal: 16, paddingVertical: 13, borderWidth: 1, borderColor: 'rgba(231,240,255,0.18)', borderRadius: 20, backgroundColor: 'rgba(206,220,247,0.09)' },
  infoRow: { minHeight: 39, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.line },
  infoLabel: { color: palette.secondary, fontSize: 10 },
  infoValue: { color: palette.text, fontSize: 10, fontWeight: '600' },
  checkedAt: { marginTop: 9, color: palette.muted, fontSize: 9 },
  secondaryButton: { minHeight: 40, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: 12, paddingHorizontal: 13, borderWidth: 1, borderColor: 'rgba(231,240,255,0.20)', borderRadius: 14, backgroundColor: 'rgba(230,237,251,0.08)' },
  secondaryButtonText: { color: palette.text, fontSize: 11, fontWeight: '600' },
  cardFootnote: { marginTop: 9, color: palette.muted, fontSize: 9, lineHeight: 14 },
  accountNote: { marginTop: 21, paddingHorizontal: 4, paddingBottom: 15 },
  accountNoteTitle: { color: palette.text, fontFamily: headingFont, fontSize: 17 },
  accountNoteCopy: { marginTop: 6, color: palette.muted, fontSize: 10, lineHeight: 16 },
  error: { color: palette.danger, marginVertical: 8, fontSize: 10 },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.75 },
});
