/**
 * Route param lists and composite prop types for the security app.
 *
 * Flow: Login → (no shift) Shift → (on shift) the gate console tab navigator.
 */

import type { CompositeScreenProps } from '@react-navigation/native';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

export type RootStackParamList = {
  Login: undefined;
  Shift: undefined;
  Console: undefined;
  WalkIn: undefined;
};

export type ConsoleTabParamList = {
  Queue: undefined;
  Scan: undefined;
  Log: undefined;
  Board: undefined;
};

/** Props for a screen inside the console tab navigator (can also pop to shift/login). */
export type ConsoleTabScreenProps<T extends keyof ConsoleTabParamList> = CompositeScreenProps<
  BottomTabScreenProps<ConsoleTabParamList, T>,
  NativeStackScreenProps<RootStackParamList>
>;

export type StackScreenProps<T extends keyof RootStackParamList> = NativeStackScreenProps<RootStackParamList, T>;
