import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { File } from "expo-file-system";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { useEffect, useState } from "react";
import { getAccessToken } from "@/lib/auth/session";
import { currentBusinessId, useBusinessContext } from "@/lib/business-context";
import { API_URL } from "@/lib/config";
import { discardFile } from "@/lib/document-file";
import { api } from "./client";
import type { Branding } from "./types";

// /api/branding: the business's logo, accent colour and invoice defaults. Any member reads it; changes
// need invoices.manage.

const useBusinessKey = () => useBusinessContext((s) => s.businessId ?? "default");

export function useBranding(enabled = true) {
  const business = useBusinessKey();
  return useQuery({
    queryKey: [business, "branding"],
    queryFn: () => api<Branding>("/api/branding"),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export type BrandingInput = {
  accentColor: string | null;
  invoice: {
    prefix: string;
    defaultDueDays: number;
    vatRateBps: number;
    vatByDefault: boolean;
    notes: string | null;
    terms: string | null;
    footer: string | null;
  };
};

type Change = { kind: "save"; input: BrandingInput } | { kind: "upload-logo"; uri: string } | { kind: "remove-logo" };

/** Saves, uploads or removes. New invoice defaults change too, so those refresh. */
export function useBrandingChange() {
  const qc = useQueryClient();
  const business = useBusinessKey();
  return useMutation({
    mutationFn: async (change: Change): Promise<Branding & { suggestedAccent?: string | null }> => {
      if (change.kind === "save") return api<Branding>("/api/branding", { method: "PATCH", json: change.input });
      if (change.kind === "remove-logo") return api<Branding>("/api/branding/logo", { method: "DELETE" });
      const form = new FormData();
      // React Native's FormData takes a file as { uri, name, type }.
      form.append("file", { uri: change.uri, name: "logo.png", type: "image/png" } as unknown as Blob);
      return api<Branding & { suggestedAccent: string | null }>("/api/branding/logo", {
        method: "POST",
        form,
        timeoutMs: 60_000,
      });
    },
    onSuccess: (branding) => {
      qc.setQueryData([business, "branding"], branding);
      void qc.invalidateQueries({ queryKey: [business, "invoices", "defaults"] });
    },
  });
}

const MAX_EDGE = 1200;

/**
 * A logo from the photo library, as a PNG (keeps transparency) at most 1200px on its long side. The backend
 * trims and resizes it again and stores its own PNG. Undefined when cancelled.
 */
export async function pickLogo(): Promise<string | undefined> {
  const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 1, exif: false });
  const photo = !result.canceled ? result.assets[0] : undefined;
  if (!photo) return undefined;
  const context = ImageManipulator.manipulate(photo.uri);
  try {
    if (Math.max(photo.width, photo.height) > MAX_EDGE)
      context.resize(photo.width >= photo.height ? { width: MAX_EDGE } : { height: MAX_EDGE });
    const image = await context.renderAsync();
    try {
      const saved = await image.saveAsync({ format: SaveFormat.PNG });
      if ((new File(saved.uri).size ?? 0) > 5 * 1024 * 1024) {
        discardFile(saved.uri);
        throw new Error("That image is over 5 MB. Choose a smaller one.");
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

/**
 * The logo as an expo-image source. Its URL is an API path that needs the session, so the request carries
 * the access token and business.
 */
export function useLogoSource(logo: Branding["logo"] | undefined) {
  const [token, setToken] = useState<string>();
  useEffect(() => {
    if (!logo) return;
    let live = true;
    void getAccessToken()
      .then((t) => live && setToken(t))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [logo]);
  if (!logo || !token) return undefined;
  const businessId = currentBusinessId();
  return {
    uri: `${API_URL}${logo.url}`,
    headers: { Authorization: `Bearer ${token}`, ...(businessId && { "X-Business-Id": businessId }) },
    // The URL carries ?v=<updated>, so a new logo is a new cache key.
    cacheKey: `${businessId ?? "default"}:${logo.url}`,
  };
}
