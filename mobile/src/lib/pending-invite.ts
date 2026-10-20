import { create } from "zustand";

/**
 * An invite opened while signed out, by someone who already has an account. They sign in first; the
 * root layout reopens the invite once the app is unlocked. Memory only.
 */
export const usePendingInvite = create<{ token?: string; set: (token?: string) => void }>((set) => ({
  token: undefined,
  set: (token) => set({ token }),
}));
