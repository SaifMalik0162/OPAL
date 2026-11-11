import { Stack } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SQLiteProvider } from 'expo-sqlite';
import { LibraryProvider } from '../data/LibraryProvider';
import { initializeDatabase } from '../data/database';
import { PlaybackProvider } from '../playback/PlaybackProvider';
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
  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <Stack screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: palette.background },
        animation: 'fade_from_bottom',
      }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="projects" />
        <Stack.Screen name="project/[id]" />
        <Stack.Screen name="now-playing" options={{ animation: 'slide_from_bottom' }} />
      </Stack>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.background },
});
