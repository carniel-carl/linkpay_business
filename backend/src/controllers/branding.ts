import type { RequestHandler, Response } from "express";
import { z } from "zod";
import type { BusinessDocument } from "../models/Business";
import { deleteLogo, describeBranding, readLogo, saveLogo } from "../services/branding";
import { HttpError } from "../utils/HttpError";

export const getBranding: RequestHandler = async (req, res) => {
  res.json(describeBranding(req.business!));
};

const text = (max: number) => z.string().trim().max(max).nullable();

/** Accent colour and invoice defaults. `null` clears a value back to its default. */
export const updateBranding: RequestHandler = async (req, res) => {
  const body = z
    .object({
      accentColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/, "Use a hex colour like #0E7C66").nullable(),
      invoice: z
        .object({
          // Becomes "<prefix>-0042". Letters and digits only, so payers can type it into a narration.
          prefix: z.string().trim().regex(/^[A-Za-z0-9]{1,8}$/, "Up to 8 letters or digits").transform((p) => p.toUpperCase()),
          defaultDueDays: z.number().int().min(0).max(365),
          vatRateBps: z.number().int().min(0).max(10_000),
          vatByDefault: z.boolean(),
          notes: text(2000),
          terms: text(2000),
          footer: text(300),
        })
        .partial(),
    })
    .partial()
    .parse(req.body);

  const business = req.business!;
  if (body.accentColor !== undefined) business.set("branding.accentColor", body.accentColor?.toUpperCase() ?? undefined);
  for (const [key, value] of Object.entries(body.invoice ?? {})) {
    business.set(`branding.invoice.${key}`, value ?? undefined);
  }
  await business.save();
  res.json(describeBranding(business));
};

/** Multipart `file`: PNG, JPG, WebP or SVG. The first logo also sets the accent colour when none is chosen. */
export const uploadLogo: RequestHandler = async (req, res) => {
  if (!req.file) throw new HttpError(400, "Attach the logo in a 'file' form field", "FILE_REQUIRED");
  const { suggestedAccent } = await saveLogo(req.business!, req.file.buffer);
  res.json({ ...describeBranding(req.business!), suggestedAccent });
};

export const removeLogo: RequestHandler = async (req, res) => {
  await deleteLogo(req.business!);
  res.json(describeBranding(req.business!));
};

/** Serves a business's logo: always a PNG we produced ourselves, never the uploaded file. */
export async function sendLogo(res: Response, business: BusinessDocument) {
  const png = await readLogo(business);
  if (!png) throw new HttpError(404, "No logo", "LOGO_NOT_FOUND");
  res
    .type("image/png")
    .setHeader("X-Content-Type-Options", "nosniff")
    .setHeader("Content-Security-Policy", "default-src 'none'")
    // Logo URLs carry ?v=<updatedAt>, so a new upload gets a new URL.
    .setHeader("Cache-Control", "public, max-age=86400")
    .send(png);
}

export const getLogo: RequestHandler = async (req, res) => {
  await sendLogo(res, req.business!);
};
