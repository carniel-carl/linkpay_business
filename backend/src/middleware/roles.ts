import type { RequestHandler } from "express";
import type { Permission } from "../config/permissions";
import type { BusinessDocument } from "../models/Business";
import type { MembershipDocument } from "../models/Membership";
import { hasPermission, resolveBusinessContext } from "../services/team";
import { HttpError } from "../utils/HttpError";

declare global {
  namespace Express {
    interface Request {
      business?: BusinessDocument;
      /** The signed-in user's membership in `business`. */
      membership?: MembershipDocument;
    }
  }
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const requestedBusinessId = (header: string | string[] | undefined) =>
  (Array.isArray(header) ? header[0] : header)?.trim() || undefined;

/**
 * Use after requireAuth on every route that needs a verified business (accounts, branches, team, ...).
 * Resolves the business from the X-Business-Id header (or the user's default) and checks membership.
 */
export const requireApprovedBusiness: RequestHandler = async (req, _res, next) => {
  const { business, membership } = await resolveBusinessContext(req.userId!, requestedBusinessId(req.headers["x-business-id"])).catch(
    (err) => {
      // Keep the original gate's contract: no business at all is a 403 here.
      if (err instanceof HttpError && err.code === "BUSINESS_REQUIRED") {
        throw new HttpError(403, "Set up your business first", "BUSINESS_REQUIRED");
      }
      throw err;
    },
  );
  if (business.status !== "approved") {
    throw new HttpError(403, "Your business is not yet approved", "BUSINESS_NOT_APPROVED");
  }
  // Compliance restrictions (services/compliance.ts): a closed business gets nothing; a suspended one is
  // read-only, so its team can still see balances and payments but can't send money or change anything.
  const restriction = business.compliance?.status ?? "active";
  if (restriction === "banned") {
    throw new HttpError(403, "This business has been closed. Contact support.", "BUSINESS_BANNED");
  }
  if (restriction === "suspended" && !READ_METHODS.has(req.method)) {
    throw new HttpError(403, "This business is suspended. You can view your account but can't make changes or send money. Contact support.", "BUSINESS_SUSPENDED");
  }
  req.business = business;
  req.membership = membership;
  next();
};

/** Use after requireApprovedBusiness. */
export const requirePermission =
  (permission: Permission): RequestHandler =>
  (req, _res, next) => {
    if (!req.membership || !hasPermission(req.membership, permission)) {
      throw new HttpError(403, "Your role doesn't allow this", "PERMISSION_DENIED");
    }
    next();
  };

export { requestedBusinessId };
