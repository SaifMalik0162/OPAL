import { usePathname, Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SQLiteProvider } from 'expo-sqlite';
import { LibraryProvider } from '../data/LibraryProvider';
import { initializeDatabase } from '../data/database';
import { PlaybackProvider } from '../playback/PlaybackProvider';
import { MiniPlayer } from '../components/MiniPlayer';
import { palette } from '../constants/theme';

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SQLiteProvider databaseName="opal-library.db" onInit={initializeDatabase}>
        <LibraryProvider>
          <PlaybackProvider>
            <RootNavigator />
          </PlaybackProvider>
        </LibraryProvider>
      </SQLiteProvider>
    </SafeAreaProvider>
  );
}

function RootNavigator() {
  const pathname = usePathname();
  const isNowPlaying = pathname === '/now-playing';

  return (
    <>
      <StatusBar style="light" />
      <Stack screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: palette.background },
        animation: 'fade_from_bottom',
      }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="project/[id]" />
        <Stack.Screen name="now-playing" options={{ animation: 'slide_from_bottom' }} />
      </Stack>
      {!isNowPlaying && <MiniPlayer />}
    </>
  );
}
