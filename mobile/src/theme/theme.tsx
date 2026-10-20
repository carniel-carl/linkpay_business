import { File, Paths } from "expo-file-system";
import * as SystemUI from "expo-system-ui";
import { createContext, useContext, useEffect, type ReactNode } from "react";
import { Appearance, useColorScheme, View, type StyleProp, type ViewStyle } from "react-native";
import { create } from "zustand";
import { palettes, shadows, themeVars, type Palette, type Scheme } from "./tokens";

type Theme = { scheme: Scheme; colors: Palette; shadows: (typeof shadows)[Scheme] };

const theme = (scheme: Scheme): Theme => ({ scheme, colors: palettes[scheme], shadows: shadows[scheme] });

const ThemeContext = createContext<Theme>(theme("light"));

/** Light, dark or the phone's setting, like the web's theme menu. A device preference, so it outlives sign-out. */
export type ThemePreference = "system" | "light" | "dark";

const preferenceFile = new File(Paths.document, "theme-preference");

function readPreference(): ThemePreference {
  try {
    const value = preferenceFile.exists ? preferenceFile.textSync() : "";
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

// Overriding the app's appearance (not just our palette) keeps native parts in step: tab bar, headers,
// alerts, switches, the keyboard and the status bar.
const applyPreference = (preference: ThemePreference) =>
  Appearance.setColorScheme(preference === "system" ? "unspecified" : preference);

const initialPreference = readPreference();
applyPreference(initialPreference);

export const useThemePreference = create<{ preference: ThemePreference; setPreference: (p: ThemePreference) => void }>(
  (set) => ({
    preference: initialPreference,
    setPreference(preference) {
      applyPreference(preference);
      set({ preference });
      try {
        if (preference === "system") {
          if (preferenceFile.exists) preferenceFile.delete();
        } else {
          if (!preferenceFile.exists) preferenceFile.create();
          preferenceFile.write(preference);
        }
      } catch {
        // Not saved: the choice still applies until the app restarts.
      }
    },
  }),
);

/** Follows the theme preference (the phone's appearance by default). Raw colours are for native props that can't take class names. */
export function ThemeRoot({ children }: { children: ReactNode }) {
  const scheme: Scheme = useColorScheme() === "dark" ? "dark" : "light";
  const background = palettes[scheme].background;

  // The window behind every screen (seen during transitions and overscroll) matches the app's paper.
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(background);
  }, [background]);

  return (
    <ThemeContext.Provider value={theme(scheme)}>
      <View style={[themeVars[scheme], { flex: 1 }]} className="bg-background">
        {children}
      </View>
    </ThemeContext.Provider>
  );
}

/**
 * Renders its children in a fixed scheme. The entrance (welcome, auth, passcode, lock) is one navy
 * field in both appearances, so its forms use the dark palette whatever the phone is set to.
 */
export function SchemeScope({ scheme, style, children }: { scheme: Scheme; style?: StyleProp<ViewStyle>; children: ReactNode }) {
  return (
    <ThemeContext.Provider value={theme(scheme)}>
      <View style={[themeVars[scheme], { flex: 1 }, style]}>{children}</View>
    </ThemeContext.Provider>
  );
}

export const useTheme = () => useContext(ThemeContext);
