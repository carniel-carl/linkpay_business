import { Pressable, Text, View } from "react-native";
import { NIGERIAN_STATES } from "@/lib/schemas";
import { TextField } from "./text-field";

/** State as a text field with matching states offered underneath, so it ends up spelled as the web's list. */
export function StateField({
  value,
  onChange,
  onBlur,
  error,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Called with the final value, after a full name typed in another case is replaced by the list's spelling. */
  onBlur?: (v: string) => void;
  error?: string;
}) {
  const query = value.trim().toLowerCase();
  const exact = NIGERIAN_STATES.some((s) => s.toLowerCase() === query);
  const matches = query && !exact ? NIGERIAN_STATES.filter((s) => s.toLowerCase().startsWith(query)).slice(0, 6) : [];
  return (
    <View className="gap-2">
      <TextField
        label="State"
        value={value}
        onChangeText={onChange}
        onBlur={() => {
          const known = NIGERIAN_STATES.find((s) => s.toLowerCase() === query);
          if (known && known !== value) onChange(known);
          onBlur?.(known ?? value);
        }}
        error={error}
        autoCapitalize="words"
        autoComplete="off"
        textContentType="none"
        placeholder="Lagos"
      />
      {matches.length > 0 && (
        <View className="flex-row flex-wrap gap-2">
          {matches.map((s) => (
            <Pressable
              key={s}
              accessibilityRole="button"
              accessibilityLabel={`Use ${s}`}
              onPress={() => {
                onChange(s);
                onBlur?.(s);
              }}
              className="h-9 justify-center rounded-full border border-input bg-card px-3.5 active:opacity-70"
            >
              <Text className="text-[14px] text-foreground">{s}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}
