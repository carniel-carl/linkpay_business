import { ApiError } from "./errors";

/** Every record id the API hands out (a MongoDB ObjectId). */
const OBJECT_ID = /^[a-f\d]{24}$/i;

/**
 * A record id as one segment of an API path. Ids also come from deep links, push payloads and notification
 * routes, so anything that isn't a 24-character hex id is refused before a request is made. Encoding alone
 * isn't enough: URL parsers still read "." and ".." (even as %2E) as dot segments, so an id like "../x"
 * could reach a different route. A valid id is hex, so it needs no encoding.
 */
export function idSegment(id: string | null | undefined): string {
  if (typeof id !== "string" || !OBJECT_ID.test(id)) throw new ApiError(404, "We couldn't find that. The link may be old or incomplete.", "INVALID_ID");
  return id;
}
