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
