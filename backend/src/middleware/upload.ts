import multer from "multer";
import { HttpError } from "../utils/HttpError";

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

// Files are kept in memory, sniffed, then handed to the storage service.
export const uploadSingle = (field: string) =>
  multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } }).single(field);

const SIGNATURES: { mime: string; ext: string; bytes: number[] }[] = [
  { mime: "application/pdf", ext: "pdf", bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  { mime: "image/png", ext: "png", bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mime: "image/jpeg", ext: "jpg", bytes: [0xff, 0xd8, 0xff] },
];

/** Detects the real file type from its first bytes rather than trusting the client's Content-Type. */
export function detectFileType(buffer: Buffer) {
  const match = SIGNATURES.find((s) => s.bytes.every((b, i) => buffer[i] === b));
  if (!match) throw new HttpError(400, "Only PDF, PNG and JPEG files are accepted", "UNSUPPORTED_FILE_TYPE");
  return match;
}
