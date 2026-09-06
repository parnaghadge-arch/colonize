/**
 * Colonize Security App — root.
 *
 * Flow: anonymous → Login; authenticated with no shift → Shift (pick gate);
 * on shift → the gate console tabs (Queue / Scan / Log / Board).
 */

import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SessionProvider, useSession } from './src/lib/session.tsx';
import { colors } from './src/components/ui.tsx';
import { type ConsoleTabParamList, type RootStackParamList } from './src/nav.ts';

import { LoginScreen } from './src/screens/LoginScreen.tsx';
import { ShiftScreen } from './src/screens/ShiftScreen.tsx';
import { QueueScreen } from './src/screens/QueueScreen.tsx';
import { ScanScreen } from './src/screens/ScanScreen.tsx';
import { LogScreen } from './src/screens/LogScreen.tsx';
import { BoardScreen } from './src/screens/BoardScreen.tsx';
import { WalkInScreen } from './src/screens/WalkInScreen.tsx';

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<ConsoleTabParamList>();

const navTheme = {
  ...DefaultTheme,
  colors: { ...DefaultTheme.colors, background: colors.bg, primary: colors.brand, card: colors.bg, text: colors.text },
};

function ConsoleTabs() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: { backgroundColor: colors.bg, borderTopColor: colors.border },
        tabBarActiveTintColor: colors.brand,
        tabBarInactiveTintColor: colors.textFaint,
      }}
    >
      <Tab.Screen
        name="Queue"
        component={QueueScreen}
        options={{
          title: 'Queue',
          tabBarIcon: ({ focused }) => <Glyph glyph="≡" focused={focused} />,
        }}
      />
      <Tab.Screen
        name="Scan"
        component={ScanScreen}
        options={{
          title: 'Scan',
          tabBarIcon: ({ focused }) => <Glyph glyph="▣" focused={focused} />,
        }}
      />
      <Tab.Screen
        name="Log"
        component={LogScreen}
        options={{
          title: 'Log',
          tabBarIcon: ({ focused }) => <Glyph glyph="↷" focused={focused} />,
        }}
      />
      <Tab.Screen
        name="Board"
        component={BoardScreen}
        options={{
          title: 'Board',
          tabBarIcon: ({ focused }) => <Glyph glyph="▦" focused={focused} />,
        }}
      />
    </Tab.Navigator>
  );
}

function Glyph({ glyph, focused }: { glyph: string; focused: boolean }) {
  return <Text style={{ fontSize: 16, opacity: focused ? 1 : 0.45 }}>{glyph}</Text>;
}

function Root() {
  const { status, bootstrapped, who, gateId } = useSession();

  if (!bootstrapped) {
    return (
      <View style={styles.boot}>
        <ActivityIndicator size="large" color={colors.brand} />
      </View>
    );
  }

  if (status === 'anonymous' || !who) {
    return (
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        <Stack.Screen name="Login" component={LoginScreen} />
      </Stack.Navigator>
    );
  }

  return (
    <Stack.Navigator screenOptions={{ headerShown: false, animation: 'slide_from_right' }}>
      {!gateId ? (
        <Stack.Screen name="Shift" component={ShiftScreen} />
      ) : (
        <Stack.Screen name="Console" component={ConsoleTabs} options={{ headerShown: true, title: 'Gate console', headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.text }} />
      )}
      <Stack.Screen name="WalkIn" component={WalkInScreen} options={{ headerShown: true, title: 'Register walk-in guest', headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.text, headerShadowVisible: false }} />
    </Stack.Navigator>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <NavigationContainer theme={navTheme}>
          <StatusBar style="light" />
          <Root />
        </NavigationContainer>
      </SessionProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  boot: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
});
