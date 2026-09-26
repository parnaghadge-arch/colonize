/**
 * Signed-in chrome for the security app.
 *
 * Back and the bottom menu stay visible on the shift picker, the gate tabs and the
 * walk-in form. Safe-area insets keep them clear of the notch when the phone rotates.
 */

import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { createNavigationContainerRef, type NavigationState, type PartialState } from '@react-navigation/native';

import { ChromeContext } from '../lib/chromeContext.ts';
import { colors } from './ui.tsx';

export const navigationRef = createNavigationContainerRef<{
  Console: { screen?: string } | undefined;
  Shift: undefined;
  WalkIn: undefined;
}>();

const TABS = [
  { name: 'Queue', label: 'Queue', glyph: '≡', screen: 'Console', nested: 'Queue' },
  { name: 'Scan', label: 'Scan', glyph: '▣', screen: 'Console', nested: 'Scan' },
  { name: 'Log', label: 'Log', glyph: '↷', screen: 'Console', nested: 'Log' },
  { name: 'Board', label: 'Board', glyph: '▦', screen: 'Console', nested: 'Board' },
  { name: 'Shift', label: 'Shift', glyph: '⏱', screen: 'Shift', nested: 'Shift' },
] as const;

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

  function goBack() {
    if (!navigationRef.isReady()) return;
    if (navigationRef.canGoBack()) {
      navigationRef.goBack();
      return;
    }
    if (route !== 'Queue') {
      navigationRef.navigate('Console', { screen: 'Queue' });
    }
  }

  function openTab(tab: (typeof TABS)[number]) {
    if (!navigationRef.isReady()) return;
    if (tab.screen === 'Shift') {
      navigationRef.navigate('Shift');
      return;
    }
    navigationRef.navigate('Console', { screen: tab.nested });
  }

  return (
    <ChromeContext.Provider value>
      <View style={[styles.shell, { paddingLeft: insets.left, paddingRight: insets.right }]}>
        <View style={[styles.backBar, { paddingTop: Math.max(insets.top, 6) }]}>
          <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={goBack} style={styles.backBtn} hitSlop={8}>
            <Text style={[styles.backLabel, !canBack && route === 'Queue' && styles.backMuted]}>‹ Back</Text>
          </Pressable>
        </View>
        <View style={styles.body}>{children}</View>
        <View style={[styles.menu, { paddingBottom: Math.max(insets.bottom, 6) }]}>
          {TABS.map((tab) => {
            const active = route === tab.name || route === tab.nested;
            return (
              <Pressable
                key={tab.name}
                accessibilityRole="button"
                accessibilityLabel={tab.label}
                onPress={() => openTab(tab)}
                style={styles.tab}
              >
                <Text style={{ fontSize: compact ? 15 : 16, color: colors.text, opacity: active ? 1 : 0.45 }}>{tab.glyph}</Text>
                <Text style={[styles.tabLabel, active && styles.tabLabelActive]} numberOfLines={1}>{tab.label}</Text>
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
  backLabel: { color: colors.brand, fontSize: 16, fontWeight: '700' },
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
  tab: { flexGrow: 1, flexBasis: 64, minWidth: 64, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  tabLabel: { fontSize: 11, color: colors.textFaint, marginTop: 1 },
  tabLabelActive: { color: colors.brand, fontWeight: '700' },
});
