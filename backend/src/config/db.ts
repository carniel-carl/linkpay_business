import mongoose from "mongoose";
import { env } from "./env";

/**
 * Connects the default connection. Scripts pass `autoIndex: false, autoCreate: false`, so connecting builds no
 * index and creates no collection (a dry run then writes nothing); the server leaves both on.
 */
export async function connectDB({ autoIndex = true, autoCreate = true }: { autoIndex?: boolean; autoCreate?: boolean } = {}) {
  mongoose.connection.on("connected", () => console.log("MongoDB connected"));
  mongoose.connection.on("error", (err) => console.error("MongoDB error:", err));
  mongoose.connection.on("disconnected", () => console.warn("MongoDB disconnected"));

  await mongoose.connect(env.mongoUri, {
    dbName: env.mongoDbName,
    ...(env.mongoUser && { user: env.mongoUser }),
    ...(env.mongoPassword && { pass: env.mongoPassword }),
    autoIndex,
    autoCreate,
  });
}

/** For scripts: see connectDB. */
export const connectScriptDB = () => connectDB({ autoIndex: false, autoCreate: false });

export async function disconnectDB() {
  await mongoose.disconnect();
}

// ---------------------------------------------------------------------------------------------------------
// Index builds
// ---------------------------------------------------------------------------------------------------------

export type IndexFailure = {
  model: string;
  collection: string;
  /** The declared index that isn't in the database; null if the build failed before any index (e.g. the collection). */
  key: Record<string, unknown> | null;
  unique: boolean;
  /** The model's first build error: the server's code name and number, never its message (a duplicate key's message holds the values). */
  error: string;
};
export type IndexReport = { models: number; failed: IndexFailure[] };

let indexState: "pending" | "ok" | "failed" = "pending";

/** For GET /health: "pending" until checkIndexes() has run, then whether every declared index was built. */
export const indexStatus = () => indexState;

function errorName(err: unknown) {
  const e = err as { code?: unknown; codeName?: unknown; message?: unknown } | null;
  if (e && typeof e.codeName === "string") return `${e.codeName}${e.code !== undefined ? ` (${e.code})` : ""}`;
  return String(e && typeof e.message === "string" ? e.message : err).split("\n")[0]!;
}

/**
 * Waits for every registered model's automatic index build and reports the indexes that failed. Mongoose
 * starts the builds itself and swallows their errors, so without this a unique index that can't build (because
 * of duplicates already stored) fails silently and uniqueness simply isn't enforced. Read-only: a model's
 * build is the one Mongoose already started, and the indexes still missing are listed, not retried.
 */
export async function checkIndexes(connection = mongoose.connection): Promise<IndexReport> {
  const names = connection.modelNames();
  const failed = (
    await Promise.all(
      names.map(async (name): Promise<IndexFailure[]> => {
        const model = connection.model(name);
        const error = await model.init().then(
          () => null,
          (err: unknown) => err ?? new Error("index build failed"),
        );
        if (!error) return [];
        const base = { model: name, collection: model.collection.name, error: errorName(error) };
        const diff = await model.diffIndexes({ indexOptionsToCreate: true }).catch(() => null);
        const missing = (diff?.toCreate ?? []) as unknown as [Record<string, unknown>, { unique?: boolean } | undefined][];
        if (!missing.length) return [{ ...base, key: null, unique: false }];
        return missing.map(([key, options]) => ({ ...base, key, unique: !!options?.unique }));
      }),
    )
  ).flat();
  indexState = failed.length ? "failed" : "ok";
  return { models: names.length, failed };
}

const keyText = (key: Record<string, unknown>) => `{ ${Object.entries(key).map(([field, dir]) => `${field}: ${JSON.stringify(dir)}`).join(", ")} }`;

/** Prints the report: one line when all is well, loudly (console.error) for every index that didn't build. */
export function logIndexReport({ models, failed }: IndexReport) {
  if (!failed.length) {
    console.log(`Indexes: every declared index is built (${models} models)`);
    return;
  }
  const unique = failed.filter((f) => f.unique).length;
  console.error(
    `\n🚨 INDEX BUILD FAILED: ${failed.length} declared index(es) aren't in the database` +
      (unique ? `, ${unique} of them unique, so those duplicates are NOT being refused.` : "."),
  );
  for (const f of failed) {
    console.error(`🚨   ${f.collection} ${f.key ? keyText(f.key) : "(collection)"}${f.unique ? " UNIQUE" : ""}: ${f.error}`);
  }
  console.error(
    "🚨 Usually duplicates already stored stop a unique index: remove them (for KYB documents, `bun run migrate:kyb`), then restart. " +
      'GET /health says indexes: "failed" until then.\n',
  );
}
