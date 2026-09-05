/**
 * Route param lists and the composite prop types for screens.
 *
 * The tab navigator is nested inside the stack navigator, so tab screens can navigate
 * both to sibling tabs and to stack screens — `CompositeScreenProps` captures both.
 */

import type { CompositeScreenProps } from '@react-navigation/native';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

export type RootStackParamList = {
  Login: undefined;
  Home: undefined;
  ComplaintDetail: { id: string };
  NewComplaint: undefined;
  BillDetail: { id: string };
  AmenityDetail: { id: string };
  Bookings: undefined;
  NewVisitor: undefined;
  QrPass: { visitorId: string };
};

export type TabParamList = {
  Home: undefined;
  Complaints: undefined;
  Bills: undefined;
  Amenities: undefined;
  Visitors: undefined;
  Profile: undefined;
};

/** Props for a screen that lives in a tab but can also push stack screens. */
export type TabScreenProps<T extends keyof TabParamList> = CompositeScreenProps<
  BottomTabScreenProps<TabParamList, T>,
  NativeStackScreenProps<RootStackParamList>
>;

/** Props for a screen pushed onto the main stack. */
export type StackScreenProps<T extends keyof RootStackParamList> = NativeStackScreenProps<RootStackParamList, T>;
