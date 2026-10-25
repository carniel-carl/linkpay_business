import type { RequestHandler } from "express";
import { env } from "../config/env";

/**
 * The oldest mobile app version this API works with (MIN_MOBILE_APP_VERSION; null: any). The app asks at launch, so
 * one that's too old shows its update screen before a request fails. Not cached: a new minimum counts from the next launch.
 */
export const appVersion: RequestHandler = (_req, res) => {
  res.set("Cache-Control", "no-store").json({ minVersion: env.minMobileAppVersion ?? null });
};
