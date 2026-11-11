import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { headingFont, palette } from '../constants/theme';
import { useLibrary } from '../data/LibraryProvider';

type Props = {
  visible: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
};

export function CreateProjectSheet({ visible, onClose, onCreated }: Props) {
  const { createProject } = useLibrary();
  const [projectName, setProjectName] = useState('');
  const [creating, setCreating] = useState(false);

  const saveProject = async () => {
    if (!projectName.trim() || creating) return;
    setCreating(true);
    try {
      const id = await createProject(projectName);
      setProjectName('');
      onClose();
      onCreated(id);
    } catch (error) {
      Alert.alert('Could not create project', error instanceof Error ? error.message : 'Please try again.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.modalRoot} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={styles.scrim} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close new project dialog" />
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
            <Pressable onPress={onClose} style={styles.cancelButton} accessibilityRole="button" accessibilityLabel="Cancel project creation">
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              disabled={!projectName.trim() || creating}
              onPress={() => void saveProject()}
              style={[styles.saveButton, (!projectName.trim() || creating) && styles.disabled]}
              accessibilityRole="button"
              accessibilityLabel="Create project"
            >
              {creating ? <ActivityIndicator color={palette.background} /> : <Text style={styles.saveText}>Create project</Text>}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalRoot: { flex: 1, justifyContent: 'center', paddingHorizontal: 20 },
  scrim: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(8, 15, 29, 0.72)' },
  modalCard: { padding: 23, borderWidth: 1, borderColor: 'rgba(239, 244, 255, 0.28)', borderRadius: 24, backgroundColor: palette.surface },
  modalEyebrow: { color: palette.lavender, fontSize: 9, letterSpacing: 1.8, fontWeight: '700' },
  modalTitle: { marginTop: 10, color: palette.text, fontFamily: headingFont, fontSize: 26 },
  input: { marginTop: 18, paddingHorizontal: 14, paddingVertical: 13, borderWidth: 1, borderColor: palette.line, borderRadius: 13, color: palette.text, fontSize: 15, backgroundColor: 'rgba(22, 36, 61, 0.42)' },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 10, marginTop: 18 },
  cancelButton: { paddingVertical: 12, paddingHorizontal: 14 },
  cancelText: { color: palette.secondary, fontSize: 13 },
  saveButton: { minWidth: 122, minHeight: 42, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14, borderRadius: 14, backgroundColor: palette.lavender },
  saveText: { color: palette.background, fontSize: 12, fontWeight: '700' },
  disabled: { opacity: 0.45 },
});
