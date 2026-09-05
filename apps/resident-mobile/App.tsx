/**
 * Colonize Resident App — root.
 *
 * One auth gate: anonymous → LoginScreen, authenticated → bottom tabs. The whole app
 * renders only after the persisted API base URL is loaded (SessionProvider.bootstrapped).
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
import { type RootStackParamList, type TabParamList } from './src/nav.ts';

import { LoginScreen } from './src/screens/LoginScreen.tsx';
import { HomeScreen } from './src/screens/HomeScreen.tsx';
import { ComplaintsScreen } from './src/screens/ComplaintsScreen.tsx';
import { ComplaintDetailScreen } from './src/screens/ComplaintDetailScreen.tsx';
import { NewComplaintScreen } from './src/screens/NewComplaintScreen.tsx';
import { BillsScreen } from './src/screens/BillsScreen.tsx';
import { BillDetailScreen } from './src/screens/BillDetailScreen.tsx';
import { AmenitiesScreen } from './src/screens/AmenitiesScreen.tsx';
import { AmenityDetailScreen } from './src/screens/AmenityDetailScreen.tsx';
import { BookingsScreen } from './src/screens/BookingsScreen.tsx';
import { VisitorsScreen } from './src/screens/VisitorsScreen.tsx';
import { NewVisitorScreen } from './src/screens/NewVisitorScreen.tsx';
import { QrPassScreen } from './src/screens/QrPassScreen.tsx';
import { ProfileScreen } from './src/screens/ProfileScreen.tsx';

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<TabParamList>();

const navTheme = {
  ...DefaultTheme,
  colors: { ...DefaultTheme.colors, background: colors.bg, primary: colors.brand },
};

function TabIcon({ glyph, focused }: { glyph: string; focused: boolean }) {
  return (
    <View style={{ opacity: focused ? 1 : 0.45 }}>
      <View style={[styles.tabIconBox, focused && styles.tabIconBoxActive]}>
        <Text style={styles.tabGlyph}>{glyph}</Text>
      </View>
    </View>
  );
}

function MainTabs() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.brandDark,
        tabBarInactiveTintColor: colors.textFaint,
      }}
    >
      <Tab.Screen name="Home" component={HomeScreen} options={{ tabBarLabel: 'Home', tabBarIcon: ({ focused }) => <TabIcon glyph="⌂" focused={focused} /> }} />
      <Tab.Screen name="Complaints" component={ComplaintsScreen} options={{ tabBarLabel: 'Complaints', tabBarIcon: ({ focused }) => <TabIcon glyph="🛠" focused={focused} /> }} />
      <Tab.Screen name="Bills" component={BillsScreen} options={{ tabBarLabel: 'Bills', tabBarIcon: ({ focused }) => <TabIcon glyph="₹" focused={focused} /> }} />
      <Tab.Screen name="Amenities" component={AmenitiesScreen} options={{ tabBarLabel: 'Amenities', tabBarIcon: ({ focused }) => <TabIcon glyph="🏸" focused={focused} /> }} />
      <Tab.Screen name="Visitors" component={VisitorsScreen} options={{ tabBarLabel: 'Visitors', tabBarIcon: ({ focused }) => <TabIcon glyph="🎟" focused={focused} /> }} />
      <Tab.Screen name="Profile" component={ProfileScreen} options={{ tabBarLabel: 'Profile', tabBarIcon: ({ focused }) => <TabIcon glyph="👤" focused={focused} /> }} />
    </Tab.Navigator>
  );
}

function Root() {
  const { status, bootstrapped, who } = useSession();

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
      <Stack.Screen name="Home" component={MainTabs} />
      <Stack.Screen name="ComplaintDetail" component={ComplaintDetailScreen} options={{ presentation: 'modal' }} />
      <Stack.Screen name="NewComplaint" component={NewComplaintScreen} />
      <Stack.Screen name="BillDetail" component={BillDetailScreen} />
      <Stack.Screen name="AmenityDetail" component={AmenityDetailScreen} />
      <Stack.Screen name="Bookings" component={BookingsScreen} />
      <Stack.Screen name="NewVisitor" component={NewVisitorScreen} />
      <Stack.Screen name="QrPass" component={QrPassScreen} options={{ presentation: 'modal' }} />
    </Stack.Navigator>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <NavigationContainer theme={navTheme}>
          <StatusBar style="dark" />
          <Root />
        </NavigationContainer>
      </SessionProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  boot: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  tabIconBox: { width: 26, height: 26, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  tabIconBoxActive: { backgroundColor: colors.brandSoft },
  tabGlyph: { fontSize: 14 },
});
