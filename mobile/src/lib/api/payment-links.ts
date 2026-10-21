import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { File } from "expo-file-system";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { useEffect, useState } from "react";
import { getAccessToken } from "@/lib/auth/session";
import { currentBusinessId, useBusinessContext } from "@/lib/business-context";
import { API_URL } from "@/lib/config";
import { discardFile } from "@/lib/document-file";
import type { CheckoutTab, LinkTab } from "@/lib/payment-links";
import { api } from "./client";
import type {
  LinkCheckout,
  LinkCheckoutList,
  PaymentLink,
  PaymentLinkEmbed,
  PaymentLinkImage,
  PaymentLinkList,
  PaymentLinkSummary,
  PhoneFieldMode,
  SuggestedPayment,
} from "./types";

// /api/payment-links (docs/briefs/payment-links.md). Reads need accounts.view; changes need payments.manage.

const useBusinessKey = () => useBusinessContext((s) => s.businessId ?? "default");
const linkPath = (id: string, rest = "") => `/api/payment-links/${encodeURIComponent(id)}${rest}`;
const checkoutPath = (id: string, rest = "") => `/api/payment-links/checkouts/${encodeURIComponent(id)}${rest}`;
const next = (last: { skip: number; items: unknown[]; total: number }) =>
  last.skip + last.items.length < last.total ? last.skip + last.items.length : undefined;

export function usePaymentLinks(tab: LinkTab, { q, enabled = true }: { q?: string; enabled?: boolean } = {}) {
  const business = useBusinessKey();
  return useInfiniteQuery({
    queryKey: [business, "payment-links", "list", tab, q],
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ skip: String(pageParam), take: "30", status: tab });
      if (q) params.set("q", q);
      return api<PaymentLinkList>(`/api/payment-links?${params}`, { signal });
    },
    initialPageParam: 0,
    getNextPageParam: next,
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function usePaymentLinkSummary(enabled = true) {
  const business = useBusinessKey();
  return useQuery({
    queryKey: [business, "payment-links", "summary"],
    queryFn: () => api<PaymentLinkSummary>("/api/payment-links/summary"),
    enabled,
  });
}

export function usePaymentLink(id: string | undefined) {
  const business = useBusinessKey();
  return useQuery({ queryKey: [business, "payment-link", id], queryFn: () => api<PaymentLink>(linkPath(id!)), enabled: !!id });
}

export function usePaymentLinkEmbed(id: string | undefined) {
  const business = useBusinessKey();
  return useQuery({
    queryKey: [business, "payment-link", id, "embed"],
    queryFn: () => api<PaymentLinkEmbed>(linkPath(id!, "/embed")),
    enabled: !!id,
    staleTime: 5 * 60_000,
  });
}

/** Checkouts for one link (or every link when `link` is undefined). */
export function useLinkCheckouts(link: string | undefined, tab: CheckoutTab, enabled = true) {
  const business = useBusinessKey();
  return useInfiniteQuery({
    queryKey: [business, "payment-links", "checkouts", link ?? "all", tab],
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ skip: String(pageParam), take: "30", status: tab });
      if (link) params.set("link", link);
      return api<LinkCheckoutList>(`/api/payment-links/checkouts?${params}`, { signal });
    },
    initialPageParam: 0,
    getNextPageParam: next,
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useLinkCheckout(id: string | undefined) {
  const business = useBusinessKey();
  return useQuery({ queryKey: [business, "link-checkout", id], queryFn: () => api<LinkCheckout>(checkoutPath(id!)), enabled: !!id });
}

/** Unlinked transfers that look like this checkout's. Fresh each time, so one that just landed shows. */
export function useCheckoutSuggestions(id: string, enabled: boolean) {
  const business = useBusinessKey();
  return useQuery({
    queryKey: [business, "link-checkout", id, "suggested"],
    queryFn: async () => (await api<{ items: SuggestedPayment[] }>(checkoutPath(id, "/suggested-payments"))).items,
    enabled,
    staleTime: 0,
    gcTime: 0,
  });
}

// ---- Changes ----

export type PaymentLinkInput = {
  title: string;
  description: string | null;
  amountKobo: number | null;
  minAmountKobo: number | null;
  phone: PhoneFieldMode;
  customFields: { _id?: string; label: string; required: boolean }[];
  /** Uploaded picture ids in order (the first is the cover). Left out, the saved pictures stay. */
  images?: string[] | null;
  successMessage: string | null;
  redirectUrl: string | null;
  allowedOrigins: string[] | null;
  expiresAt: string | null;
  maxPayments: number | null;
};

type Change =
  | { kind: "create"; input: PaymentLinkInput & { branch: string } }
  | { kind: "update"; id: string; input: Partial<PaymentLinkInput> & { status?: "active" | "inactive" } }
  | { kind: "delete"; id: string }
  | { kind: "match"; checkoutId: string; transactionId: string };

/** A new link has nothing to clear, so nulls are left out. */
const withoutNulls = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== ""));

function run(change: Change): Promise<PaymentLink | LinkCheckout | undefined> {
  switch (change.kind) {
    case "create":
      return api<PaymentLink>("/api/payment-links", { method: "POST", json: withoutNulls(change.input) });
    case "update":
      return api<PaymentLink>(linkPath(change.id), { method: "PATCH", json: change.input });
    case "delete":
      return api<undefined>(linkPath(change.id), { method: "DELETE" });
    case "match":
      return api<LinkCheckout>(checkoutPath(change.checkoutId, "/match"), { method: "POST", json: { transactionId: change.transactionId } });
  }
}

/** Every change to links and checkouts. The answer replaces the cached item; lists and the summary refresh. */
export function usePaymentLinkChange() {
  const qc = useQueryClient();
  const business = useBusinessKey();
  return useMutation({
    mutationFn: run,
    onSuccess: (result, change) => {
      if (change.kind === "match" && result) {
        qc.setQueryData([business, "link-checkout", change.checkoutId], result);
        const linkId = (result as LinkCheckout).link?._id;
        if (linkId) void qc.invalidateQueries({ queryKey: [business, "payment-link", linkId] });
        void qc.invalidateQueries({ queryKey: [business, "transactions"] });
      } else if (result) {
        qc.setQueryData([business, "payment-link", (result as PaymentLink)._id], result);
      }
      if (change.kind === "delete") qc.removeQueries({ queryKey: [business, "payment-link", change.id] });
      void qc.invalidateQueries({ queryKey: [business, "payment-links"] });
    },
  });
}

// ---- Pictures (docs/briefs/payment-links.md §6) ----

const MAX_EDGE = 2000;

/**
 * A picture from the photo library as a JPEG (HEIC photos are converted here, since the backend doesn't read
 * them), at most 2000px on its long side. The backend re-encodes it again. Undefined when cancelled.
 */
export async function pickLinkPicture(): Promise<string | undefined> {
  const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 1, exif: false });
  const photo = !result.canceled ? result.assets[0] : undefined;
  if (!photo) return undefined;
  const context = ImageManipulator.manipulate(photo.uri);
  try {
    if (Math.max(photo.width, photo.height) > MAX_EDGE)
      context.resize(photo.width >= photo.height ? { width: MAX_EDGE } : { height: MAX_EDGE });
    const image = await context.renderAsync();
    try {
      const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.85 });
      if ((new File(saved.uri).size ?? 0) > 5 * 1024 * 1024) {
        discardFile(saved.uri);
        throw new Error("That picture is over 5 MB. Choose a smaller one.");
      }
      return saved.uri;
    } finally {
      image.release();
    }
  } finally {
    context.release();
    discardFile(photo.uri);
  }
}

/** Uploads a picked picture before the link is saved; send its `_id` in `images`. */
export async function uploadLinkPicture(uri: string) {
  const form = new FormData();
  // React Native's FormData takes a file as { uri, name, type }.
  form.append("file", { uri, name: "picture.jpg", type: "image/jpeg" } as unknown as Blob);
  try {
    return await api<PaymentLinkImage>("/api/payment-links/images", { method: "POST", form, timeoutMs: 60_000 });
  } finally {
    discardFile(uri);
  }
}

/** A picture as an expo-image source: its URL is an API path that needs the session and the business. */
export function useLinkImageSource(image: Pick<PaymentLinkImage, "url"> | undefined) {
  const [token, setToken] = useState<string>();
  const url = image?.url;
  useEffect(() => {
    if (!url) return;
    let live = true;
    void getAccessToken()
      .then((t) => live && setToken(t))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [url]);
  if (!url || !token) return undefined;
  const businessId = currentBusinessId();
  return {
    uri: `${API_URL}${url}`,
    headers: { Authorization: `Bearer ${token}`, ...(businessId && { "X-Business-Id": businessId }) },
    // Each picture's id is new when it changes, so the URL is a stable cache key.
    cacheKey: `${businessId ?? "default"}:${url}`,
  };
}
