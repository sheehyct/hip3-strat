// Small form primitives: a labelled text input, a numeric input, a switch
// row. Label and value are separate Text nodes (Android clipping rule).
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import type { StyleProp, TextInputProps, ViewStyle } from "react-native";

import { C, F, S, T } from "@/theme";

export function Field({
  label, value, onChange, placeholder, secure, hint, error, style, inputProps, suffix,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  secure?: boolean;
  hint?: string;
  error?: string | null;
  style?: StyleProp<ViewStyle>;
  inputProps?: TextInputProps;
  suffix?: string;
}) {
  return (
    <View style={[f.field, style]}>
      <Text style={f.label}>{label}</Text>
      <View style={f.inputRow}>
        <TextInput
          value={value}
          onChangeText={onChange}
          placeholder={placeholder}
          placeholderTextColor={C.faint}
          secureTextEntry={secure}
          autoCapitalize="none"
          autoCorrect={false}
          style={[f.input, error ? f.inputErr : null]}
          {...inputProps}
        />
        {suffix ? <Text style={f.suffix}>{suffix}</Text> : null}
      </View>
      {error ? <Text style={f.error}>{error}</Text> : hint ? <Text style={f.hint}>{hint}</Text> : null}
    </View>
  );
}

export function NumField({
  label, value, onChange, suffix, hint, style, min, max,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  suffix?: string;
  hint?: string;
  style?: StyleProp<ViewStyle>;
  min?: number;
  max?: number;
}) {
  const text = value === null ? "" : String(value);
  const err = value !== null && ((min !== undefined && value < min) || (max !== undefined && value > max)) ? "out of range" : null;
  return (
    <Field
      label={label}
      value={text}
      onChange={(v) => { const n = parseFloat(v); onChange(v.trim() === "" ? null : Number.isFinite(n) ? n : value); }}
      suffix={suffix}
      hint={hint}
      error={err}
      style={style}
      inputProps={{ keyboardType: "decimal-pad", inputMode: "decimal" }}
    />
  );
}

export function SwitchRow({ label, value, onChange, hint }: { label: string; value: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <Pressable onPress={() => onChange(!value)} style={f.switchRow} accessibilityRole="switch" accessibilityState={{ checked: value }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={f.switchLabel}>{label}</Text>
        {hint ? <Text style={f.hint}>{hint}</Text> : null}
      </View>
      <Switch value={value} onValueChange={onChange} trackColor={{ false: C.borderStrong, true: C.accentBorder }} thumbColor={value ? C.accent : C.muted} />
    </Pressable>
  );
}

// A compact numeric text box used inside dense rows (order panel, quick
// size editor).
export function MiniInput({
  value, onChange, suffix, width = 86, placeholder, style, align = "right", onBlur,
}: {
  value: string;
  onChange: (v: string) => void;
  suffix?: string;
  width?: number;
  placeholder?: string;
  style?: StyleProp<ViewStyle>;
  align?: "left" | "right";
  onBlur?: () => void;
}) {
  return (
    <View style={[f.mini, { minWidth: width }, style]}>
      <TextInput
        value={value}
        onChangeText={onChange}
        onBlur={onBlur}
        placeholder={placeholder}
        placeholderTextColor={C.faint}
        keyboardType="decimal-pad"
        inputMode="decimal"
        style={[f.miniInput, { textAlign: align }]}
      />
      {suffix ? <Text style={f.miniSuffix}>{suffix}</Text> : null}
    </View>
  );
}

const f = StyleSheet.create({
  field: { gap: 4 },
  label: { ...F.medium, color: C.faint, fontSize: T.micro },
  inputRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  input: {
    ...F.regular, flex: 1, minWidth: 0, color: C.text, fontSize: T.body, backgroundColor: C.bg, borderWidth: 1, borderColor: C.border,
    borderRadius: S.radiusSm, paddingHorizontal: 10, paddingVertical: 9, minHeight: 40,
  },
  inputErr: { borderColor: "rgba(255,59,92,0.6)" },
  suffix: { ...F.medium, color: C.muted, fontSize: T.caption },
  hint: { ...F.regular, color: C.faint, fontSize: T.micro, lineHeight: 15 },
  error: { ...F.regular, color: C.bear, fontSize: T.micro, lineHeight: 15 },
  switchRow: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 44, paddingVertical: 4 },
  switchLabel: { ...F.medium, color: C.text, fontSize: T.body },
  mini: {
    flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: C.bg, borderWidth: 1, borderColor: C.border, borderRadius: S.radiusSm,
    paddingHorizontal: 8, minHeight: 36,
  },
  miniInput: { ...F.medium, flex: 1, minWidth: 0, color: C.text, fontSize: T.body, paddingVertical: 6, fontVariant: ["tabular-nums"] },
  miniSuffix: { ...F.regular, color: C.faint, fontSize: T.micro },
});
