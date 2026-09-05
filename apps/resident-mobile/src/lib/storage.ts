/**
 * Secure storage wrapper.
 *
 * The bearer token and active society id live in the OS keychain/keystore
 * (expo-secure-store) — never in plain AsyncStorage. Other small settings use
 * plain AsyncStorage. Both are no-ops on web, where in-memory values suffice.
 */

import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

const isWeb = Platform.OS === 'web';

// Web fallback: SecureStore is a native module and has no web implementation.
const webMemory = new Map<string, string>();

export const secureStore = {
  async getItem(key: string): Promise<string | null> {
    if (isWeb) return webMemory.get(key) ?? null;
    return SecureStore.getItemAsync(key);
  },
  async setItem(key: string, value: string): Promise<void> {
    if (isWeb) {
      webMemory.set(key, value);
      return;
    }
    await SecureStore.setItemAsync(key, value);
  },
  async deleteItem(key: string): Promise<void> {
    if (isWeb) {
      webMemory.delete(key);
      return;
    }
    await SecureStore.deleteItemAsync(key);
  },
};

export const settings = {
  async get<T>(key: string, fallback: T): Promise<T> {
    const raw = await AsyncStorage.getItem(`colonize.resident.${key}`);
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  },
  async set(key: string, value: unknown): Promise<void> {
    await AsyncStorage.setItem(`colonize.resident.${key}`, JSON.stringify(value));
  },
  async remove(key: string): Promise<void> {
    await AsyncStorage.removeItem(`colonize.resident.${key}`);
  },
};
