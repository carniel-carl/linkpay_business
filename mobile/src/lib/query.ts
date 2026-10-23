import { focusManager, QueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AppState, Platform } from "react-native";
import { ApiError } from "@/lib/api/errors";

// Refetch stale data when the app comes back to the foreground, as the web does on window focus.
focusManager.setEventListener((setFocused) => {
  const sub = AppState.addEventListener("change", (state) => {
    if (Platform.OS !== "web") setFocused(state === "active");
  });
  return () => sub.remove();
});

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // Client errors (401, 403, 404) won't fix themselves; network blips might.
      retry: (count, err) => count < 2 && !(err instanceof ApiError && err.status >= 400 && err.status < 500),
    },
    mutations: { retry: false },
  },
});

/**
 * A RefreshControl's state: spinning only while a refresh the user pulled for runs. Not `isRefetching`, which is
 * also true for background refetches (back in the foreground, invalidations, polling): on iOS a refresh control
 * that starts while its screen is hidden, such as a tab behind another, stays stuck open with a gap above the list.
 *
 *   const pull = usePullToRefresh(() => Promise.all([list.refetch(), summary.refetch()]));
 *   <RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />
 */
export function usePullToRefresh(refresh: () => Promise<unknown>) {
  const [refreshing, setRefreshing] = useState(false);
  async function onRefresh() {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }
  return { refreshing, onRefresh: () => void onRefresh() };
}
