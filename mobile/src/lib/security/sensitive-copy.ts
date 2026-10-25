import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";

/** How long a copied secret stays on the clipboard: time to paste it into an authenticator app or password manager. */
export const SECRET_ON_CLIPBOARD_MS = 60_000;

/**
 * Copies a secret (the authenticator key, recovery codes), and takes it off the clipboard after a minute or when the
 * screen closes, but only if it's still what's there: anything copied since is left alone. Not on going to the
 * background, since that's where it gets pasted. Android also keeps it out of the clipboard preview; expo-clipboard
 * has no expiring or this-device-only copy on iOS. `copied` is true while it may still be on the clipboard.
 */
export function useSensitiveCopy() {
  const [copied, setCopied] = useState(false);
  const onClipboard = useRef<{ text: string; until: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const clear = useCallback(async (now = false) => {
    const c = onClipboard.current;
    // Android doesn't let an app in the background read the clipboard, so that waits until it's back.
    if (!c || (!now && Date.now() < c.until) || AppState.currentState !== "active") return;
    onClipboard.current = null;
    setCopied(false);
    if ((await Clipboard.getStringAsync().catch(() => "")) === c.text) await Clipboard.setStringAsync("").catch(() => false);
  }, []);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void clear();
    });
    return () => {
      sub.remove();
      clearTimeout(timer.current);
      void clear(true);
    };
  }, [clear]);

  async function copy(text: string) {
    await Clipboard.setStringAsync(text, { android: { isSensitive: true } });
    onClipboard.current = { text, until: Date.now() + SECRET_ON_CLIPBOARD_MS };
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void clear(true), SECRET_ON_CLIPBOARD_MS);
  }

  return { copied, copy };
}
