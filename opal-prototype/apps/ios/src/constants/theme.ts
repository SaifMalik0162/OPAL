import { Platform } from 'react-native';

export const palette = {
  // Tuned to the supplied desktop reference: a cool slate-indigo field with
  // pale blue glass, rather than the older plum product palette.
  background: '#2B3B5A',
  backgroundSoft: '#35496B',
  surface: '#4C6083',
  surfaceRaised: '#607496',
  line: 'rgba(239, 244, 255, 0.25)',
  text: '#F7F7FC',
  secondary: 'rgba(247, 248, 255, 0.82)',
  muted: 'rgba(235, 240, 255, 0.64)',
  lavender: '#D6D8F1',
  lavenderBright: '#F0F0FF',
  success: '#B8DED4',
  danger: '#F0B8C2',
  glass: 'rgba(191, 207, 237, 0.30)',
  glassStrong: 'rgba(25, 39, 66, 0.82)',
  canvasTop: '#657797',
  canvasBottom: '#233657',
};

export const headingFont = Platform.select({ ios: 'Georgia', android: 'serif', default: undefined });
