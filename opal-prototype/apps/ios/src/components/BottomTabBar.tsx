import { usePathname, useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { IconGlyph, type OpalIcon } from './IconButton';
import { GlassSurface } from './GlassSurface';
import { palette } from '../constants/theme';

const tabs: { label: string; path: '/' | '/projects' | '/settings'; icon: OpalIcon }[] = [
  { label: 'Library', path: '/', icon: 'music' },
  { label: 'Projects', path: '/projects', icon: 'folder' },
  { label: 'Settings', path: '/settings', icon: 'settings' },
];

export function BottomTabBar() {
  const pathname = usePathname();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const selectedPath = pathname === '/settings' ? '/settings' : pathname === '/projects' || pathname.startsWith('/project/') ? '/projects' : '/';

  return (
    <View style={[styles.position, { bottom: Math.max(insets.bottom, 8) + 8 }]} pointerEvents="box-none">
      <GlassSurface style={styles.shell} isInteractive>
        {tabs.map((tab) => {
          const selected = selectedPath === tab.path;
          return (
            <Pressable
              key={tab.path}
              accessibilityRole="button"
              accessibilityLabel={tab.label}
              accessibilityState={{ selected }}
              onPress={() => router.navigate(tab.path as never)}
              style={({ pressed }) => [styles.tab, pressed && styles.pressed]}
            >
              <View style={[styles.tabContent, selected && styles.tabContentSelected]}>
                <IconGlyph icon={tab.icon} size={18} color={selected ? palette.text : palette.secondary} />
                <Text style={[styles.label, selected && styles.labelSelected]}>{tab.label}</Text>
              </View>
            </Pressable>
          );
        })}
      </GlassSurface>
    </View>
  );
}

const styles = StyleSheet.create({
  position: { position: 'absolute', left: 26, right: 26, zIndex: 12, alignItems: 'center' },
  shell: { width: '100%', maxWidth: 352, minHeight: 60, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', padding: 5, borderRadius: 32 },
  tab: { flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 2, borderRadius: 26 },
  tabContent: { width: '100%', minHeight: 42, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, paddingHorizontal: 6, borderRadius: 23 },
  tabContentSelected: { backgroundColor: 'rgba(237, 241, 255, 0.19)', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(248,250,255,0.22)' },
  label: { color: palette.secondary, fontSize: 12, fontWeight: '500' },
  labelSelected: { color: palette.text, fontWeight: '600' },
  pressed: { opacity: 0.76 },
});
