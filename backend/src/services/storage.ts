import path from "node:path";
import { env } from "../config/env";

export interface FileStorage {
  save(key: string, data: Buffer): Promise<void>;
  read(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

// Local disk storage for development. Swap for S3/GCS/R2 in production via setFileStorage().
const localStorage: FileStorage = {
  async save(key, data) {
    await Bun.write(path.join(env.uploadDir, key), data);
  },
  async read(key) {
    return Buffer.from(await Bun.file(path.join(env.uploadDir, key)).arrayBuffer());
  },
  async remove(key) {
    const file = Bun.file(path.join(env.uploadDir, key));
    if (await file.exists()) await file.delete();
  },
};

let storage: FileStorage = localStorage;

export function setFileStorage(next: FileStorage) {
  storage = next;
}

export const saveFile = (key: string, data: Buffer) => storage.save(key, data);
export const readFile = (key: string) => storage.read(key);
export const removeFile = (key: string) => storage.remove(key);
