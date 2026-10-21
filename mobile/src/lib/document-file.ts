import * as DocumentPicker from "expo-document-picker";
import { File, Paths } from "expo-file-system";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import type { UploadFile } from "@/lib/api/onboarding";
import { MAX_UPLOAD_BYTES } from "@/lib/kyb";

// Getting a verification document off the phone. The backend accepts only PDF, PNG and JPEG (it reads
// the file's first bytes), so every photo is converted to JPEG here: the iPhone camera saves HEIC, and
// the photo library and Files can hand over HEIC, WebP or large PNGs.

export type DocumentSource = "camera" | "photos" | "files";

export type PickResult =
  | { ok: true; file: UploadFile }
  | { ok: false; reason: "cancelled" }
  | { ok: false; reason: "denied" | "invalid"; message: string };

/** Long edge of a converted photo: plenty for a reviewer to read a CAC certificate or an ID. */
const MAX_EDGE = 2400;

const tooBig = "That file is over 5 MB. Upload a smaller file, or take a photo of the page instead.";

const sizeOf = (uri: string) => new File(uri).size ?? 0;

/** Deletes a copy the app made (camera shots, picker and converter copies live in the cache). Never touches the user's own files. */
export function discardFile(uri: string) {
  try {
    if (!uri.startsWith(Paths.cache.uri)) return;
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // Best effort: the cache is cleared by the system anyway.
  }
}

/** Any image the phone can open becomes a JPEG at most MAX_EDGE on its long side, under the upload limit. */
export async function toJpeg(uri: string, name: string): Promise<UploadFile> {
  const context = ImageManipulator.manipulate(uri);
  let image = await context.renderAsync();
  if (Math.max(image.width, image.height) > MAX_EDGE) {
    context.resize(image.width >= image.height ? { width: MAX_EDGE } : { height: MAX_EDGE });
    image.release();
    image = await context.renderAsync();
  }
  try {
    let saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.82 });
    // A busy page can still be large; one stronger pass is enough at this size.
    if (sizeOf(saved.uri) > MAX_UPLOAD_BYTES) {
      discardFile(saved.uri);
      saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.55 });
    }
    if (sizeOf(saved.uri) > MAX_UPLOAD_BYTES) {
      discardFile(saved.uri);
      throw new Error(tooBig);
    }
    return { uri: saved.uri, name: `${name.replace(/\.[^.]+$/, "") || "document"}.jpg`, type: "image/jpeg" };
  } finally {
    image.release();
    context.release();
  }
}

async function fromCamera(): Promise<PickResult> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) {
    return { ok: false, reason: "denied", message: "Allow camera access for LinkPay Business in Settings to take a photo of the document." };
  }
  const result = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 1, exif: false });
  if (result.canceled || !result.assets[0]) return { ok: false, reason: "cancelled" };
  const shot = result.assets[0];
  try {
    return { ok: true, file: await toJpeg(shot.uri, "photo") };
  } finally {
    discardFile(shot.uri);
  }
}

async function fromPhotos(): Promise<PickResult> {
  // The system photo picker runs outside the app, so no library permission is needed to choose one photo.
  const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 1, exif: false });
  if (result.canceled || !result.assets[0]) return { ok: false, reason: "cancelled" };
  const photo = result.assets[0];
  try {
    return { ok: true, file: await toJpeg(photo.uri, photo.fileName ?? "photo") };
  } finally {
    discardFile(photo.uri);
  }
}

async function fromFiles(): Promise<PickResult> {
  const result = await DocumentPicker.getDocumentAsync({ type: ["application/pdf", "image/*"], copyToCacheDirectory: true, multiple: false });
  if (result.canceled || !result.assets[0]) return { ok: false, reason: "cancelled" };
  const asset = result.assets[0];
  const isPdf = asset.mimeType === "application/pdf" || /\.pdf$/i.test(asset.name);
  if (isPdf) {
    if ((asset.size ?? sizeOf(asset.uri)) > MAX_UPLOAD_BYTES) {
      discardFile(asset.uri);
      return { ok: false, reason: "invalid", message: tooBig };
    }
    return { ok: true, file: { uri: asset.uri, name: asset.name, type: "application/pdf" } };
  }
  if (asset.mimeType?.startsWith("image/") || /\.(heic|heif|jpe?g|png|webp)$/i.test(asset.name)) {
    try {
      return { ok: true, file: await toJpeg(asset.uri, asset.name) };
    } finally {
      discardFile(asset.uri);
    }
  }
  discardFile(asset.uri);
  return { ok: false, reason: "invalid", message: "Choose a PDF or a photo of the document." };
}

/** Takes or chooses a document and returns a file the backend accepts. */
export async function pickDocument(source: DocumentSource): Promise<PickResult> {
  try {
    return await (source === "camera" ? fromCamera() : source === "photos" ? fromPhotos() : fromFiles());
  } catch (err) {
    const message = err instanceof Error && err.message === tooBig ? tooBig : "We couldn't read that file. Try another photo or a PDF.";
    return { ok: false, reason: "invalid", message };
  }
}
