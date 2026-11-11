import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { SymbolView, type AndroidSymbol, type SFSymbol } from 'expo-symbols';
import { palette } from '../constants/theme';

export type OpalIcon = 'back' | 'add' | 'play' | 'pause' | 'next' | 'previous' | 'bookmark' | 'folder' | 'more' | 'close' | 'check' | 'music' | 'search' | 'waveform' | 'open' | 'chevronDown';

const symbols: Record<OpalIcon, { ios: SFSymbol; android: AndroidSymbol }> = {
  back: { ios: 'chevron.left', android: 'arrow_back' },
  add: { ios: 'plus', android: 'add' },
  play: { ios: 'play.fill', android: 'play_arrow' },
  pause: { ios: 'pause.fill', android: 'pause' },
  next: { ios: 'forward.end.fill', android: 'skip_next' },
  previous: { ios: 'backward.end.fill', android: 'skip_previous' },
  bookmark: { ios: 'bookmark', android: 'bookmark' },
  folder: { ios: 'folder', android: 'folder_open' },
  more: { ios: 'ellipsis', android: 'more_horiz' },
  close: { ios: 'xmark', android: 'close' },
  check: { ios: 'checkmark', android: 'check' },
  music: { ios: 'music.note', android: 'music_note' },
  search: { ios: 'magnifyingglass', android: 'search' },
  waveform: { ios: 'waveform', android: 'graphic_eq' },
  open: { ios: 'arrow.up.right', android: 'arrow_outward' },
  chevronDown: { ios: 'chevron.down', android: 'arrow_drop_down' },
};

type Props = {
  icon: OpalIcon;
  label: string;
  onPress: () => void;
  size?: number;
  color?: string;
  background?: string;
  style?: StyleProp<ViewStyle>;
  disabled?: boolean;
};

export function IconButton({ icon, label, onPress, size = 20, color = palette.text, background, style, disabled }: Props) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.button, background ? { backgroundColor: background } : null, pressed && styles.pressed, disabled && styles.disabled, style]}
      hitSlop={6}
    >
      <IconGlyph icon={icon} size={size} color={color} />
    </Pressable>
  );
}

export function IconGlyph({ icon, size = 20, color = palette.text }: Pick<Props, 'icon' | 'size' | 'color'>) {
  return <SymbolView name={symbols[icon]} size={size} tintColor={color} fallback={null} />;
}

const styles = StyleSheet.create({
  button: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 22 },
  pressed: { opacity: 0.68, transform: [{ scale: 0.96 }] },
  disabled: { opacity: 0.35 },
});
