import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { Platform, StyleSheet, View, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';
import { palette } from '../constants/theme';

type Props = ViewProps & {
  style?: StyleProp<ViewStyle>;
  glassEffectStyle?: 'clear' | 'regular' | 'none';
  isInteractive?: boolean;
};

export function GlassSurface({ children, style, glassEffectStyle = 'regular', isInteractive = false, ...props }: Props) {
  const supportsLiquidGlass = Platform.OS === 'ios' && isLiquidGlassAvailable();
  if (supportsLiquidGlass) {
    return (
      <GlassView
        {...props}
        glassEffectStyle={glassEffectStyle}
        isInteractive={isInteractive}
        colorScheme="dark"
        tintColor="rgba(191, 207, 242, 0.17)"
        style={[styles.nativeBase, style]}
      >
        {children}
      </GlassView>
    );
  }

  return (
    <View {...props} style={[styles.fallback, style]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  nativeBase: { borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(245,247,255,0.30)' },
  fallback: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(235,241,255,0.28)',
    backgroundColor: palette.glass,
    shadowColor: '#101C37',
    shadowOpacity: 0.2,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 10 },
    elevation: 9,
  },
});
