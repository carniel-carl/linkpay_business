import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { File, Paths } from "expo-file-system";
import { Platform, Share } from "react-native";
import { getAccessToken, invalidateAccessToken, refreshSession } from "@/lib/auth/session";
import { currentBusinessId, useBusinessContext } from "@/lib/business-context";
import { API_URL } from "@/lib/config";
import type { InvoiceTab } from "@/lib/invoices";
import { api } from "./client";
import { ApiError } from "./errors";
import type {
  Invoice,
  InvoiceCustomerList,
  InvoiceDefaults,
  InvoiceList,
  InvoiceSummary,
  PaymentMethod,
  SuggestedPayment,
} from "./types";

// /api/invoices. Reads need accounts.view; everything that changes an invoice needs invoices.manage.

const useBusinessKey = () => useBusinessContext((s) => s.businessId ?? "default");
const path = (id: string, rest = "") => `/api/invoices/${encodeURIComponent(id)}${rest}`;

export function useInvoices(tab: InvoiceTab, { q, enabled = true }: { q?: string; enabled?: boolean } = {}) {
  const business = useBusinessKey();
  return useInfiniteQuery({
    queryKey: [business, "invoices", "list", tab, q],
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ skip: String(pageParam), take: "30" });
      if (tab !== "all") params.set("status", tab);
      if (q) params.set("q", q);
      return api<InvoiceList>(`/api/invoices?${params}`, { signal });
    },
    initialPageParam: 0,
    getNextPageParam: (last) =>
      last.skip + last.items.length < last.total ? last.skip + last.items.length : undefined,
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useInvoiceSummary(enabled = true) {
  const business = useBusinessKey();
  return useQuery({
    queryKey: [business, "invoices", "summary"],
    queryFn: () => api<InvoiceSummary>("/api/invoices/summary"),
    enabled,
  });
}

/** One invoice, with its items, payments and where the customer pays. */
export function useInvoice(id: string | undefined) {
  const business = useBusinessKey();
  return useQuery({
    queryKey: [business, "invoice", id],
    queryFn: () => api<Invoice>(path(id!)),
    enabled: !!id,
  });
}

export function useInvoiceDefaults(enabled: boolean) {
  const business = useBusinessKey();
  return useQuery({
    queryKey: [business, "invoices", "defaults"],
    queryFn: () => api<InvoiceDefaults>("/api/invoices/defaults"),
    enabled,
    staleTime: 0,
  });
}

export function useCustomers(q: string | undefined) {
  const business = useBusinessKey();
  return useQuery({
    queryKey: [business, "invoices", "customers", q],
    queryFn: () =>
      api<InvoiceCustomerList>(`/api/invoices/customers?${new URLSearchParams({ take: "100", ...(q && { q }) })}`),
    placeholderData: keepPreviousData,
  });
}

/** Unlinked incoming payments that might be for this invoice. Fresh each time, so one that just landed shows. */
export function useSuggestedPayments(id: string, enabled: boolean) {
  const business = useBusinessKey();
  return useQuery({
    queryKey: [business, "invoice", id, "suggested"],
    queryFn: async () => (await api<{ items: SuggestedPayment[] }>(path(id, "/suggested-payments"))).items,
    enabled,
    staleTime: 0,
    gcTime: 0,
  });
}

// ---- Changes ----

export type InvoiceInput = {
  branch: string;
  customer: { id: string } | { name: string; email?: string; phone?: string; address?: string; save?: boolean };
  issueDate: string;
  dueDate: string;
  items: { description: string; quantity: number; unitPriceKobo: number }[];
  discount: { type: "amount"; amountKobo: number } | { type: "percent"; percentBps: number } | null;
  vatRateBps: number | null;
  notes: string | null;
  terms: string | null;
  footer: string | null;
  remindersEnabled: boolean;
};
/** Once an invoice has payments, only dates, notes, terms, footer and reminders can change. */
export type InvoicePatch = Partial<InvoiceInput>;

export type RecordPaymentInput =
  { transactionId: string } | { amountKobo: number; method: PaymentMethod; paidAt?: string; note?: string };

type Change =
  | { kind: "create"; input: InvoiceInput }
  | { kind: "update"; id: string; input: InvoicePatch }
  | { kind: "send"; id: string; email: boolean; to?: string; message?: string }
  | { kind: "remind" | "void" | "duplicate"; id: string }
  | { kind: "delete"; id: string }
  | { kind: "reminders"; id: string; enabled: boolean }
  | { kind: "record-payment"; id: string; input: RecordPaymentInput }
  | { kind: "remove-payment"; id: string; paymentId: string };

function run(change: Change): Promise<Invoice | undefined> {
  switch (change.kind) {
    case "create":
      return api<Invoice>("/api/invoices", { method: "POST", json: change.input });
    case "update":
      return api<Invoice>(path(change.id), { method: "PATCH", json: change.input });
    case "send":
      return api<Invoice>(path(change.id, "/send"), {
        method: "POST",
        json: { email: change.email, to: change.to, message: change.message },
      });
    case "remind":
    case "void":
    case "duplicate":
      return api<Invoice>(path(change.id, `/${change.kind}`), { method: "POST", json: {} });
    case "delete":
      return api<undefined>(path(change.id), { method: "DELETE" });
    case "reminders":
      return api<Invoice>(path(change.id), { method: "PATCH", json: { remindersEnabled: change.enabled } });
    case "record-payment":
      return api<Invoice>(path(change.id, "/payments"), { method: "POST", json: change.input });
    case "remove-payment":
      return api<Invoice>(path(change.id, `/payments/${encodeURIComponent(change.paymentId)}`), { method: "DELETE" });
  }
}

/** Every change to an invoice. The answer replaces the cached invoice; lists and the summary refresh. */
export function useInvoiceChange() {
  const qc = useQueryClient();
  const business = useBusinessKey();
  return useMutation({
    mutationFn: run,
    onSuccess: (invoice, change) => {
      if (invoice) qc.setQueryData([business, "invoice", invoice._id], invoice);
      if (change.kind === "delete") qc.removeQueries({ queryKey: [business, "invoice", change.id] });
      void qc.invalidateQueries({ queryKey: [business, "invoices"] });
      // A linked payment changes what the payments list shows as matched.
      if (change.kind === "record-payment" || change.kind === "remove-payment")
        void qc.invalidateQueries({ queryKey: [business, "transactions"] });
    },
  });
}

// ---- PDF ----

/**
 * Downloads the invoice (or, once paid, the receipt) as a PDF and opens it in the phone's own viewer, which
 * can share or save it. Signed in, so it works for drafts too.
 */
export async function openInvoicePdf(invoice: Pick<Invoice, "_id" | "number" | "status">) {
  const kind = invoice.status === "paid" ? "receipt" : "invoice";
  const url = `${API_URL}${path(invoice._id, `/pdf?kind=${kind}`)}`;
  const get = async (token: string) => {
    const businessId = currentBusinessId();
    return fetch(url, {
      headers: { Authorization: `Bearer ${token}`, ...(businessId && { "X-Business-Id": businessId }) },
    });
  };
  let res: Response;
  try {
    res = await get(await getAccessToken());
    if (res.status === 401) {
      invalidateAccessToken();
      res = await get(await refreshSession());
    }
  } catch {
    throw new ApiError(0, "Network request failed", "NETWORK");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body?.error ?? "We couldn't open the PDF.", body?.code);
  }

  const file = new File(Paths.cache, `${kind === "receipt" ? "Receipt" : "Invoice"} ${invoice.number}.pdf`);
  if (file.exists) file.delete();
  file.create();
  await file.write(new Uint8Array(await res.arrayBuffer()));
  try {
    await File.preview(file);
  } catch {
    // No previewer: iOS shares the file itself; Android can only share text, so the caller falls back.
    if (Platform.OS !== "ios")
      throw new ApiError(0, "This phone can't show the PDF. Share the invoice link instead.", "NO_PDF_VIEWER");
    await Share.share({ url: file.uri });
  }
}
