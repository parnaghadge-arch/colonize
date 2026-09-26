/**
 * Signed-in chrome for the resident app.
 *
 * The back control and the bottom menu sit outside the navigator, so they stay on
 * every signed-in screen — including bill detail and other stack screens that used
 * to cover the tabs. Safe-area insets are applied here so a notch or home indicator
 * never covers them, in portrait or landscape.
 */

import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { createNavigationContainerRef, type NavigationState, type PartialState } from '@react-navigation/native';

import { ChromeContext } from '../lib/chromeContext.ts';
import { colors } from './ui.tsx';

export const navigationRef = createNavigationContainerRef<{ Home: { screen?: string } | undefined }>();

const TABS = [
  { name: 'Home', label: 'Home', glyph: '⌂' },
  { name: 'Complaints', label: 'Complaints', glyph: '🛠' },
  { name: 'Bills', label: 'Bills', glyph: '₹' },
  { name: 'Amenities', label: 'Amenities', glyph: '🏸' },
  { name: 'Visitors', label: 'Visitors', glyph: '🎟' },
  { name: 'Profile', label: 'Profile', glyph: '👤' },
] as const;

const TAB_FOR: Record<string, string> = {
  Home: 'Home',
  Complaints: 'Complaints',
  ComplaintDetail: 'Complaints',
  NewComplaint: 'Complaints',
  Bills: 'Bills',
  BillDetail: 'Bills',
  Amenities: 'Amenities',
  AmenityDetail: 'Amenities',
  Bookings: 'Amenities',
  Visitors: 'Visitors',
  NewVisitor: 'Visitors',
  QrPass: 'Visitors',
  Profile: 'Profile',
};

function deepestRoute(state: NavigationState | PartialState<NavigationState> | undefined): string {
  if (!state || state.index == null || !state.routes?.length) return '';
  const route = state.routes[state.index];
  if (route?.state) return deepestRoute(route.state as NavigationState) || route.name;
  return route?.name ?? '';
}

export function SignedInChrome({ children }: { children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const compact = width < 380;
  const [route, setRoute] = useState('');
  const [canBack, setCanBack] = useState(false);

  useEffect(() => {
    let unsubscribe = () => {};
    const sync = () => {
      if (!navigationRef.isReady()) return;
      setCanBack(navigationRef.canGoBack());
      setRoute(deepestRoute(navigationRef.getRootState()));
    };
    const attach = () => {
      if (!navigationRef.isReady()) return false;
      sync();
      unsubscribe = navigationRef.addListener('state', sync);
      return true;
    };
    if (attach()) return () => unsubscribe();
    const timer = setInterval(() => {
      if (attach()) clearInterval(timer);
    }, 40);
    return () => {
      clearInterval(timer);
      unsubscribe();
    };
  }, []);

  const activeTab = TAB_FOR[route] ?? '';

  function goBack() {
    if (!navigationRef.isReady()) return;
    if (navigationRef.canGoBack()) {
      navigationRef.goBack();
      return;
    }
    if (activeTab !== 'Home') {
      navigationRef.navigate('Home', { screen: 'Home' });
    }
  }

  function openTab(name: string) {
    if (!navigationRef.isReady()) return;
    navigationRef.navigate('Home', { screen: name });
  }

  return (
    <ChromeContext.Provider value>
      <View style={[styles.shell, { paddingLeft: insets.left, paddingRight: insets.right }]}>
        <View style={[styles.backBar, { paddingTop: Math.max(insets.top, 6) }]}>
          <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={goBack} style={styles.backBtn} hitSlop={8}>
            <Text style={[styles.backLabel, !canBack && activeTab === 'Home' && styles.backMuted]}>‹ Back</Text>
          </Pressable>
        </View>
        <View style={styles.body}>{children}</View>
        <View style={[styles.menu, { paddingBottom: Math.max(insets.bottom, 6) }]}>
          {TABS.map((tab) => {
            const active = activeTab === tab.name;
            return (
              <Pressable
                key={tab.name}
                accessibilityRole="button"
                accessibilityLabel={tab.label}
                onPress={() => openTab(tab.name)}
                style={styles.tab}
              >
                <Text style={{ fontSize: compact ? 15 : 16, opacity: active ? 1 : 0.45 }}>{tab.glyph}</Text>
                <Text style={[styles.tabLabel, compact && styles.tabLabelCompact, active && styles.tabLabelActive]} numberOfLines={1}>
                  {tab.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    </ChromeContext.Provider>
  );
}

const styles = StyleSheet.create({
  shell: { flex: 1, backgroundColor: colors.bg, minHeight: 0 },
  backBar: {
    flexShrink: 0,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingHorizontal: 8,
    paddingBottom: 4,
  },
  backBtn: { minHeight: 44, minWidth: 44, justifyContent: 'center', paddingHorizontal: 8, alignSelf: 'flex-start' },
  backLabel: { color: colors.brandDark, fontSize: 16, fontWeight: '700' },
  backMuted: { opacity: 0.35 },
  body: { flex: 1, minHeight: 0 },
  menu: {
    flexShrink: 0,
    flexDirection: 'row',
    flexWrap: 'wrap',
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 6,
  },
  tab: { flexGrow: 1, flexBasis: 56, minWidth: 56, minHeight: 48, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 2 },
  tabLabel: { fontSize: 11, color: colors.textFaint, marginTop: 1 },
  tabLabelCompact: { fontSize: 10 },
  tabLabelActive: { color: colors.brandDark, fontWeight: '700' },
});
