/**
 * Secure storage wrapper (security app).
 *
 * The bearer token, active society id and the current gate posting live in the OS
 * keychain/keystore (expo-secure-store). Web falls back to an in-memory map.
 */

import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

const isWeb = Platform.OS === 'web';

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
    const raw = await AsyncStorage.getItem(`colonize.security.${key}`);
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  },
  async set(key: string, value: unknown): Promise<void> {
    await AsyncStorage.setItem(`colonize.security.${key}`, JSON.stringify(value));
  },
  async remove(key: string): Promise<void> {
    await AsyncStorage.removeItem(`colonize.security.${key}`);
  },
};
