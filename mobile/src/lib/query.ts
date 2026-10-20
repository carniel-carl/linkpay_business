import { focusManager, QueryClient } from "@tanstack/react-query";
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
