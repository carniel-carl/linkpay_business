import { Text, type TextProps } from "react-native";
import { cn } from "@/lib/cn";

/** The default text colour, unless the caller sets its own (two text-* classes would conflict). */
const withColor = (className?: string) => cn(/(^|\s)text-(?!\[)/.test(className ?? "") ? undefined : "text-foreground", className);

const DISPLAY_FAMILY = { medium: "BricolageDisplay-Medium", semibold: "BricolageDisplay-SemiBold", bold: "BricolageDisplay-Bold" };

/**
 * Titles and hero figures in Bricolage Grotesque, set like the web's `type-display`:
 * width 92 (baked into the font files), -0.035em tracking, tight leading.
 */
export function Display({
  size = 32,
  weight = "semibold",
  className,
  style,
  ...props
}: TextProps & { size?: number; weight?: keyof typeof DISPLAY_FAMILY; className?: string }) {
  return (
    <Text
      accessibilityRole="header"
      maxFontSizeMultiplier={1.25}
      className={withColor(className)}
      style={[
        { fontFamily: DISPLAY_FAMILY[weight], fontSize: size, lineHeight: Math.round(size * 1.08), letterSpacing: -0.035 * size },
        style,
      ]}
      {...props}
    />
  );
}

/** Money, account numbers and counts: Bricolage at text optical size with tabular digits. */
export function Figure({ size = 17, className, style, ...props }: TextProps & { size?: number; className?: string }) {
  return (
    <Text
      maxFontSizeMultiplier={1.4}
      className={withColor(className)}
      style={[
        { fontFamily: "BricolageText-SemiBold", fontSize: size, letterSpacing: -0.01 * size, fontVariant: ["tabular-nums"] },
        style,
      ]}
      {...props}
    />
  );
}
