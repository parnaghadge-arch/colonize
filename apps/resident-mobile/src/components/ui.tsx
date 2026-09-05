/**
 * Shared UI kit for the resident app — same design tokens as the web console.
 * Deliberately dependency-free (no UI library): View/Text-based primitives.
 */

import React, { type ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export const colors = {
  bg: '#f5f6f8',
  surface: '#ffffff',
  surface2: '#fafbfc',
  border: '#e3e6ea',
  borderStrong: '#cfd4da',
  text: '#16191d',
  textMuted: '#5c6672',
  textFaint: '#8a939e',
  brand: '#1f6feb',
  brandDark: '#1758c4',
  brandSoft: '#eaf1fe',
  success: '#16794f',
  successSoft: '#e6f4ed',
  warning: '#96690a',
  warningSoft: '#fdf3dc',
  danger: '#b42318',
  dangerSoft: '#fdecea',
  info: '#0b6b7d',
  infoSoft: '#e5f4f7',
};

export function Screen({ children, scroll = true, style }: { children: ReactNode; scroll?: boolean; style?: object }) {
  return (
    <SafeAreaView style={[styles.safe, style]} edges={['top', 'left', 'right']}>
      {scroll ? <ScrollView contentContainerStyle={styles.scrollContent}>{children}</ScrollView> : <View style={styles.scrollContent}>{children}</View>}
    </SafeAreaView>
  );
}

export function ScreenTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <View style={{ marginBottom: 16 }}>
      <Text style={styles.title}>{title}</Text>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
    </View>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: object }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function CardHeader({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <View style={styles.cardHeader}>
      <Text style={styles.cardTitle}>{title}</Text>
      {right}
    </View>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  loading = false,
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  style?: object;
}) {
  const bg =
    variant === 'primary' ? colors.brand : variant === 'danger' ? colors.danger : variant === 'secondary' ? colors.brandSoft : 'transparent';
  const fg = variant === 'secondary' || variant === 'ghost' ? colors.brandDark : '#fff';
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, borderColor: variant === 'ghost' ? colors.border : 'transparent' },
        (disabled || loading) && { opacity: 0.55 },
        pressed && !disabled && !loading && { opacity: 0.85 },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <Text style={[styles.buttonLabel, { color: fg }]}>{label}</Text>
      )}
    </Pressable>
  );
}

export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  autoCapitalize = 'none',
  autoCorrect = false,
  keyboardType = 'default',
  secureTextEntry = false,
  multiline = false,
  error,
  hint,
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  autoCorrect?: boolean;
  keyboardType?: 'default' | 'numeric' | 'phone-pad' | 'email-address' | 'decimal-pad';
  secureTextEntry?: boolean;
  multiline?: boolean;
  error?: string;
  hint?: string;
}) {
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textFaint}
        autoCapitalize={autoCapitalize}
        autoCorrect={autoCorrect}
        keyboardType={keyboardType}
        secureTextEntry={secureTextEntry}
        multiline={multiline}
        style={[styles.input, multiline && { minHeight: 96, textAlignVertical: 'top' }, error && { borderColor: colors.danger }]}
      />
      {error ? <Text style={styles.fieldError}>{error}</Text> : hint ? <Text style={styles.fieldHint}>{hint}</Text> : null}
    </View>
  );
}

/** A row of tappable choice chips (single-select). */
export function ChoiceRow<T extends string>({
  options,
  value,
  onSelect,
  columns = 3,
}: {
  options: readonly T[];
  value: T | null;
  onSelect: (value: T) => void;
  columns?: number;
}) {
  const width = `${100 / columns}%` as `${number}%`;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -4, marginBottom: 14 }}>
      {options.map((option) => {
        const selected = value === option;
        return (
          <View key={option} style={{ width, paddingHorizontal: 4, marginBottom: 8 }}>
            <Pressable
              onPress={() => onSelect(option)}
              style={[styles.chip, selected && { backgroundColor: colors.brand, borderColor: colors.brand }]}
            >
              <Text style={[styles.chipLabel, selected && { color: '#fff' }]}>{option.toLowerCase()}</Text>
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}

const STATUS_TONES: Record<string, { fg: string; bg: string }> = {
  open: { fg: colors.info, bg: colors.infoSoft },
  'in progress': { fg: colors.brandDark, bg: colors.brandSoft },
  assigned: { fg: colors.brandDark, bg: colors.brandSoft },
  pending: { fg: colors.warning, bg: colors.warningSoft },
  awaiting_approval: { fg: colors.warning, bg: colors.warningSoft },
  approved: { fg: colors.success, bg: colors.successSoft },
  pre_approved: { fg: colors.success, bg: colors.successSoft },
  inside: { fg: colors.success, bg: colors.successSoft },
  confirmed: { fg: colors.success, bg: colors.successSoft },
  captured: { fg: colors.success, bg: colors.successSoft },
  paid: { fg: colors.success, bg: colors.successSoft },
  completed: { fg: colors.success, bg: colors.successSoft },
  resolved: { fg: colors.success, bg: colors.successSoft },
  closed: { fg: colors.success, bg: colors.successSoft },
  due: { fg: colors.warning, bg: colors.warningSoft },
  partial: { fg: colors.warning, bg: colors.warningSoft },
  overdue: { fg: colors.danger, bg: colors.dangerSoft },
  rejected: { fg: colors.danger, bg: colors.dangerSoft },
  cancelled: { fg: colors.danger, bg: colors.dangerSoft },
  canceled: { fg: colors.danger, bg: colors.dangerSoft },
  expired: { fg: colors.textFaint, bg: colors.bg },
};

export function StatusChip({ status }: { status: string | null | undefined }) {
  const key = String(status ?? '').toLowerCase().replace(/_/g, ' ');
  const tone = STATUS_TONES[key] ?? { fg: colors.textMuted, bg: colors.bg };
  const label = String(status ?? '—')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\p{L}/gu, (c) => c.toUpperCase());
  return (
    <View style={[styles.statusChip, { backgroundColor: tone.bg }]}>
      <Text style={[styles.statusChipLabel, { color: tone.fg }]}>{label}</Text>
    </View>
  );
}

export function Alert({ tone, children }: { tone: 'error' | 'success' | 'info' | 'warning'; children: ReactNode }) {
  const tones = {
    error: { fg: colors.danger, bg: colors.dangerSoft },
    success: { fg: colors.success, bg: colors.successSoft },
    info: { fg: colors.info, bg: colors.infoSoft },
    warning: { fg: colors.warning, bg: colors.warningSoft },
  } as const;
  const t = tones[tone];
  return (
    <View style={{ backgroundColor: t.bg, borderRadius: 10, padding: 12, marginBottom: 14, borderWidth: 1, borderColor: t.fg + '33' }}>
      <Text style={{ color: t.fg, fontSize: 14, lineHeight: 20 }}>{children}</Text>
    </View>
  );
}

export function EmptyState({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      {subtitle ? <Text style={styles.emptySubtitle}>{subtitle}</Text> : null}
    </View>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <View style={{ paddingVertical: 40, alignItems: 'center', gap: 10 }}>
      <ActivityIndicator size="large" color={colors.brand} />
      <Text style={{ color: colors.textMuted, fontSize: 14 }}>{label}</Text>
    </View>
  );
}

export function KV({ label, value, mono = false }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <View style={styles.kvRow}>
      <Text style={styles.kvLabel}>{label}</Text>
      <Text style={[styles.kvValue, mono && { fontFamily: 'monospace', fontSize: 13 }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  scrollContent: { padding: 16, paddingBottom: 32 },
  title: { fontSize: 24, fontWeight: '700', color: colors.text, letterSpacing: -0.3 },
  subtitle: { fontSize: 14, color: colors.textMuted, marginTop: 2 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    marginBottom: 12,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  cardTitle: { fontSize: 15, fontWeight: 600, color: colors.text },
  button: {
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  buttonLabel: { fontSize: 15, fontWeight: '600' },
  fieldLabel: { fontSize: 13, fontWeight: '600', color: colors.textMuted, marginBottom: 6 },
  input: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 12,
    fontSize: 15,
    color: colors.text,
  },
  fieldError: { color: colors.danger, fontSize: 12.5, marginTop: 5 },
  fieldHint: { color: colors.textFaint, fontSize: 12.5, marginTop: 5 },
  chip: {
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 999,
    paddingVertical: 8,
    paddingHorizontal: 10,
    alignItems: 'center',
    backgroundColor: colors.surface,
  },
  chipLabel: { fontSize: 12.5, color: colors.textMuted, textAlign: 'center' },
  statusChip: { borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3.5, alignSelf: 'flex-start' },
  statusChipLabel: { fontSize: 11.5, fontWeight: '600' },
  empty: { paddingVertical: 48, alignItems: 'center' },
  emptyTitle: { fontSize: 16, fontWeight: '600', color: colors.text },
  emptySubtitle: { fontSize: 13.5, color: colors.textMuted, marginTop: 6, textAlign: 'center', lineHeight: 19 },
  kvRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', paddingVertical: 5, gap: 12 },
  kvLabel: { fontSize: 13.5, color: colors.textMuted, flexShrink: 0 },
  kvValue: { fontSize: 14, color: colors.text, fontWeight: '500', textAlign: 'right' },
});
