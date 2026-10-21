import { Platform } from "react-native";

/**
 * FlatList and SectionList settings for the app's long lists (payments, transfers, invoices, notifications,
 * customers, banks). Rows vary in height, so there's no getItemLayout; instead: render about one screen
 * first, add the rest in small batches, and keep fewer screens mounted off-screen than the default 21.
 * Android also detaches rows that scroll out of view (on iOS that can leave blank rows, so it stays off).
 * Rows are memoised and take `onPress(item)`, so a new page or a refetch doesn't re-render rows on screen.
 */
export const LIST_PERFORMANCE = {
  initialNumToRender: 12,
  maxToRenderPerBatch: 10,
  updateCellsBatchingPeriod: 50,
  windowSize: 9,
  removeClippedSubviews: Platform.OS === "android",
} as const;

/** Stable key for anything with a Mongo `_id`. */
export const keyById = (item: { _id: string }) => item._id;
