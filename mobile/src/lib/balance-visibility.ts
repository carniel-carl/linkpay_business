import { File, Paths } from "expo-file-system";
import { create } from "zustand";

// Hide or show balances (Home cards, account details). A device preference, like the appearance, so it
// outlives restarts and sign-out. Not a secret: it only decides what's drawn on screen.

const file = new File(Paths.document, "balances-hidden");

function readHidden() {
  try {
    return file.exists;
  } catch {
    return false;
  }
}

export const useBalanceVisibility = create<{ hidden: boolean; toggle: () => void }>((set, get) => ({
  hidden: readHidden(),
  toggle() {
    const hidden = !get().hidden;
    set({ hidden });
    try {
      if (hidden && !file.exists) file.create();
      if (!hidden && file.exists) file.delete();
    } catch {
      // Not saved: the choice still applies until the app restarts.
    }
  },
}));

/** What a hidden amount shows instead of the figure. */
export const HIDDEN_AMOUNT = "₦ ••••••";
