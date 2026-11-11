import { Image, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import type { Project } from '../data/models';
import { palette } from '../constants/theme';

const artwork = [
  require('../../assets/images/artwork/slow-light.png'),
  require('../../assets/images/artwork/veil-atlas.png'),
  require('../../assets/images/artwork/night-bloom.png'),
];

type Props = {
  project: Pick<Project, 'artworkIndex'>;
  size: number;
  style?: StyleProp<ViewStyle>;
};

export function ProjectArtwork({ project, size, style }: Props) {
  const source = artwork[Math.abs(project.artworkIndex) % artwork.length];
  return (
    <View style={[styles.frame, { width: size, height: size }, style]}>
      <Image source={source} resizeMode="cover" style={StyleSheet.absoluteFill} />
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { overflow: 'hidden', borderRadius: 16, backgroundColor: palette.backgroundSoft },
});
