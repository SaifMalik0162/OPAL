import { Platform } from 'react-native';

export const palette = {
  background: '#111018',
  backgroundSoft: '#191722',
  surface: '#211F2D',
  surfaceRaised: '#2A2737',
  line: 'rgba(237, 231, 248, 0.12)',
  text: '#F4F0F7',
  secondary: '#C7C0D1',
  muted: '#918A9D',
  lavender: '#C8B8EC',
  lavenderBright: '#E1D4FA',
  plum: '#6B527D',
  success: '#B4D2C1',
  danger: '#E6A6AE',
};

export const headingFont = Platform.select({ ios: 'Georgia', android: 'serif', default: undefined });
