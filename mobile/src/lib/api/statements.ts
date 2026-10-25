import { Directory, File, Paths } from "expo-file-system";
import { Platform, Share } from "react-native";
import { getAccessToken, invalidateAccessToken, refreshSession } from "@/lib/auth/session";
import { currentBusinessId } from "@/lib/business-context";
import { API_URL } from "@/lib/config";
import { APP_HEADERS } from "@/lib/device";
import { ApiError } from "./errors";
import type { StatementFormat } from "./types";

// GET /api/transactions/statement: one branch account's statement as a PDF or CSV file (docs/briefs/statements.md).

export type StatementRequest = { branch: string; from: string; to: string; format: StatementFormat };

/** Where the file went: shown in the phone's viewer, handed to the share sheet, saved to a folder, or nowhere. */
export type StatementOutcome = "opened" | "shared" | "saved" | "cancelled";

const MIME: Record<StatementFormat, string> = { pdf: "application/pdf", csv: "text/csv" };
// A long period can be thousands of rows, and the server makes statements a couple at a time.
const TIMEOUT_MS = 120_000;

/** The file name the server gave it (linkpay-statement-<branch>-<from>-<to>.<format>), or a plain one. */
function fileName(disposition: string | null, q: StatementRequest) {
  const match = /filename="([^"/\\]+)"/.exec(disposition ?? "");
  return match?.[1] ?? `linkpay-statement-${q.from}-${q.to}.${q.format}`;
}

async function download(q: StatementRequest) {
  const url = `${API_URL}/api/transactions/statement?${new URLSearchParams(q)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const get = (token: string) => {
    const businessId = currentBusinessId();
    return fetch(url, {
      headers: { ...APP_HEADERS, Authorization: `Bearer ${token}`, ...(businessId && { "X-Business-Id": businessId }) },
      signal: controller.signal,
    });
  };
  try {
    let res: Response;
    try {
      res = await get(await getAccessToken());
      if (res.status === 401) {
        invalidateAccessToken();
        res = await get(await refreshSession());
      }
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw controller.signal.aborted ? new ApiError(0, "Request timed out", "TIMEOUT") : new ApiError(0, "Network request failed", "NETWORK");
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new ApiError(res.status, body?.error ?? "We couldn't make the statement.", body?.code, body?.details);
    }
    return { bytes: new Uint8Array(await res.arrayBuffer()), name: fileName(res.headers.get("content-disposition"), q) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Downloads the statement and opens it the way invoice PDFs open: in the phone's own viewer (Quick Look on
 * iPhone, which reads CSV too and can share or save it; the app for that file type on Android). Without one,
 * the iPhone shares the file itself, and Android asks for a folder to save it in.
 */
export async function openStatement(q: StatementRequest): Promise<StatementOutcome> {
  const { bytes, name } = await download(q);
  const file = new File(Paths.cache, name);
  if (file.exists) file.delete();
  file.create();
  await file.write(bytes);
  try {
    await File.preview(file);
    return "opened";
  } catch {
    // No viewer for this kind of file.
  }
  if (Platform.OS === "ios") {
    await Share.share({ url: file.uri });
    return "shared";
  }
  // Android's share sheet only takes text, so the file is saved where the person chooses (no new native code:
  // expo-file-system's folder picker).
  let folder: Directory;
  try {
    folder = await Directory.pickDirectoryAsync();
  } catch {
    return "cancelled";
  }
  try {
    const saved = folder.createFile(name, MIME[q.format]);
    await saved.write(bytes);
    return "saved";
  } catch {
    throw new ApiError(0, "We couldn't save the statement there. Choose another folder.", "SAVE_FAILED");
  } finally {
    if (file.exists) file.delete();
  }
}
