import { Image, StyleSheet, View } from 'react-native';
import { palette } from '../constants/theme';

const atmosphere = require('../../assets/images/artwork/veil-atlas.png');

export function AmbientCanvas() {
  return (
    <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={StyleSheet.absoluteFill}>
      <View style={styles.base} />
      <Image source={atmosphere} resizeMode="cover" blurRadius={92} style={styles.glow} />
      <View style={styles.veil} />
    </View>
  );
}

const styles = StyleSheet.create({
  base: { ...StyleSheet.absoluteFill, backgroundColor: palette.background },
  glow: { ...StyleSheet.absoluteFill, opacity: 0.13 },
  veil: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(36, 53, 82, 0.50)' },
});
