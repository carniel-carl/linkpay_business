import { Directory, File, Paths } from "expo-file-system";

// Statements and invoice PDFs the app downloads to show or share. They hold the business's payments and customers,
// so they're kept in one folder of the cache and signing out deletes the folder (the system may clear it sooner).

const folder = () => new Directory(Paths.cache, "downloads");

/** An empty file in the downloads folder, replacing one of the same name. */
export function downloadFile(name: string) {
  const file = new File(folder(), name);
  if (file.exists) file.delete();
  file.create({ intermediates: true });
  return file;
}

/** On signing out. Best effort: it never holds up or fails the sign-out. */
export function deleteDownloads() {
  try {
    const dir = folder();
    if (dir.exists) dir.delete();
  } catch {
    // Left for the system to clear with the rest of the cache.
  }
}
