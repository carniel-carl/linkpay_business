import { randomBytes } from "node:crypto";
import { isValidObjectId, Types } from "mongoose";
import sharp, { type Metadata } from "sharp";
import { LINK_IMAGE_RULES, PAYMENT_LINK_LIMITS } from "../config/paymentLinks";
import { PaymentLinkImageModel, type PaymentLinkDocument, type PaymentLinkImageDocument } from "../models/PaymentLink";
import { HttpError } from "../utils/HttpError";
import { readFile, removeFile, saveFile } from "./storage";

// Pictures on payment links (contract: docs/briefs/payment-links.md §6). Uploaded on their own, then attached
// to a link by id when it's created or edited.

const FORMATS = new Set(["png", "jpeg", "webp"]);
const HOUR = 3_600_000;

/** Turns an upload into a WebP we made: rotated upright, metadata stripped, no larger than 1600px. */
async function processImage(input: Buffer) {
  let meta: Metadata;
  try {
    meta = await sharp(input).metadata();
  } catch {
    throw new HttpError(400, "That file isn't a picture we can read. Use PNG, JPG or WebP.", "UNSUPPORTED_FILE_TYPE");
  }
  if (!meta.format || !FORMATS.has(meta.format)) throw new HttpError(400, "Use a PNG, JPG or WebP picture", "UNSUPPORTED_FILE_TYPE");
  const { data, info } = await sharp(input, { limitInputPixels: 60_000_000 })
    .rotate()
    .resize({ width: LINK_IMAGE_RULES.maxSide, height: LINK_IMAGE_RULES.maxSide, fit: "inside", withoutEnlargement: true })
    .webp({ quality: LINK_IMAGE_RULES.webpQuality })
    .toBuffer({ resolveWithObject: true });
  if (info.width < LINK_IMAGE_RULES.minSide && info.height < LINK_IMAGE_RULES.minSide) {
    throw new HttpError(400, `That picture is too small. Use one at least ${LINK_IMAGE_RULES.minSide} pixels wide.`, "IMAGE_TOO_SMALL");
  }
  return { webp: data, width: info.width, height: info.height };
}

export async function uploadLinkImage(businessId: Types.ObjectId, userId: string, input: Buffer) {
  const { webp, width, height } = await processImage(input);
  const key = `payment-links/${businessId}/${randomBytes(9).toString("hex")}.webp`;
  await saveFile(key, webp);
  return PaymentLinkImageModel.create({ business: businessId, key, width, height, uploadedBy: userId });
}

/** The images a create or edit asks for, in order: this business's uploads, unattached or already on this link. */
export async function resolveLinkImages(businessId: Types.ObjectId, ids: string[], linkId?: Types.ObjectId) {
  const unique = [...new Set(ids)];
  if (unique.length > PAYMENT_LINK_LIMITS.maxImages) {
    throw new HttpError(400, `A link can have up to ${PAYMENT_LINK_LIMITS.maxImages} pictures`, "PAYMENT_LINK_IMAGE_LIMIT");
  }
  if (unique.some((id) => !isValidObjectId(id))) throw new HttpError(400, "One of the pictures wasn't found. Upload it again.", "IMAGE_NOT_FOUND");
  const found = await PaymentLinkImageModel.find({
    _id: { $in: unique },
    business: businessId,
    $or: [{ link: { $exists: false } }, ...(linkId ? [{ link: linkId }] : [])],
  });
  if (found.length !== unique.length) throw new HttpError(400, "One of the pictures wasn't found. Upload it again.", "IMAGE_NOT_FOUND");
  return unique.map((id) => found.find((f) => f.id === id)!);
}

async function deleteImages(images: PaymentLinkImageDocument[]) {
  if (!images.length) return;
  await PaymentLinkImageModel.deleteMany({ _id: { $in: images.map((i) => i._id) } });
  await Promise.all(images.map((i) => removeFile(i.key).catch(() => {})));
}

/** Puts `images` on the link in that order; pictures it had before and no longer lists are deleted. */
export async function setLinkImages(link: PaymentLinkDocument, images: PaymentLinkImageDocument[]) {
  const keep = new Set(images.map((i) => i.id));
  const dropped = await PaymentLinkImageModel.find({ link: link._id, _id: { $nin: images.map((i) => i._id) } });
  link.set("images", images.map((i) => i._id));
  await link.save();
  await PaymentLinkImageModel.updateMany({ _id: { $in: images.map((i) => i._id) } }, { link: link._id });
  await deleteImages(dropped.filter((d) => !keep.has(d.id)));
}

/** A deleted link's pictures. */
export async function deleteLinkImages(linkId: Types.ObjectId) {
  await deleteImages(await PaymentLinkImageModel.find({ link: linkId }));
}

/** The link's pictures in order, as stored. */
export async function linkImages(link: Pick<PaymentLinkDocument, "images">) {
  const ids = (link.images ?? []).map(String);
  if (!ids.length) return [];
  const found = await PaymentLinkImageModel.find({ _id: { $in: ids } });
  return ids.flatMap((id) => found.filter((f) => f.id === id));
}

/** Uploads nobody attached within a day: deleted with their files. */
export async function deleteUnattachedImages(now = new Date()) {
  const stale = await PaymentLinkImageModel.find({
    link: { $exists: false },
    createdAt: { $lt: new Date(now.getTime() - LINK_IMAGE_RULES.unattachedHours * HOUR) },
  }).limit(500);
  await deleteImages(stale);
  return stale.length;
}

export function startLinkImageCleanup(intervalMs: number) {
  const run = () => deleteUnattachedImages().catch((err) => console.error("Deleting unattached payment-link pictures failed:", err));
  const timer = setInterval(run, intervalMs);
  return () => clearInterval(timer);
}

/** Dashboard shape: the URL is the signed-in route (no host). */
export const describeImage = (i: PaymentLinkImageDocument) => ({
  _id: i.id as string,
  url: `/api/payment-links/images/${i.id}`,
  width: i.width,
  height: i.height,
});

/** Payer shape: a public URL relative to the API, versioned so it can be cached. */
export const describePublicImage = (slug: string, i: PaymentLinkImageDocument) => ({
  _id: i.id as string,
  url: `/api/public/pay/${slug}/images/${i.id}?v=${i.get("createdAt")?.getTime?.() ?? 0}`,
  width: i.width,
  height: i.height,
});

/** Sends a stored picture: always our WebP, never the upload. */
export async function sendLinkImage(res: import("express").Response, image: PaymentLinkImageDocument, cache: string) {
  const data = await readFile(image.key).catch(() => null);
  if (!data) throw new HttpError(404, "Picture not found", "IMAGE_NOT_FOUND");
  res
    .type("image/webp")
    .setHeader("X-Content-Type-Options", "nosniff")
    .setHeader("Content-Security-Policy", "default-src 'none'")
    .setHeader("Cache-Control", cache)
    .send(data);
}
