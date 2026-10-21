import { forwardRef, type ComponentProps } from "react";
import { formatNairaInput } from "@/lib/send-draft";
import { TextField, type TextInputRef } from "./text-field";

type Props = Omit<ComponentProps<typeof TextField>, "value" | "onChangeText" | "keyboardType"> & {
  value: string;
  onChangeText: (value: string) => void;
};

/**
 * A ₦ amount field that groups thousands as you type ("2000000" shows as "2,000,000").
 * `value` and `onChangeText` carry the formatted text; read it with parseNaira, which ignores commas.
 */
export const NairaField = forwardRef<TextInputRef, Props>(function NairaField({ value, onChangeText, ...props }, ref) {
  return (
    <TextField
      ref={ref}
      keyboardType="decimal-pad"
      {...props}
      value={formatNairaInput(value)}
      onChangeText={(v) => onChangeText(formatNairaInput(v))}
    />
  );
});
