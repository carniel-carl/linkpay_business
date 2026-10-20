import { DOCUMENT_TYPES, KYB_REQUIREMENTS, type DocumentType } from "../config/kyb";
import type { BusinessDocument } from "../models/Business";
import type { KybDocument } from "../models/KybDocument";

type Doc = KybDocument & { _id: unknown };

export type ChecklistItem = {
  key: string;
  label: string;
  done: boolean;
  // Present when a reviewer rejected the uploaded document.
  rejectionReason?: string;
};

const REQUIRED_FIELDS = [
  ["registrationNumber", "Registration number (RC/BN)"],
  ["tin", "Tax Identification Number"],
  ["industry", "Industry"],
  ["phone", "Business phone number"],
  ["address.street", "Street address"],
  ["address.city", "City"],
  ["address.state", "State"],
] as const;

/** What the owner still has to provide before the business can be submitted for review. */
export function buildChecklist(business: BusinessDocument, documents: Doc[]) {
  const requirement = KYB_REQUIREMENTS[business.type];
  const items: ChecklistItem[] = [];

  for (const [field, label] of REQUIRED_FIELDS) {
    items.push({ key: `field:${field}`, label, done: !!business.get(field) });
  }

  const docItem = (key: string, label: string, match?: Doc): ChecklistItem => ({
    key,
    label,
    done: !!match && match.status !== "rejected",
    ...(match?.status === "rejected" && { rejectionReason: match.rejectionReason ?? undefined }),
  });

  for (const type of requirement.documents) {
    const match = documents.find((d) => d.type === type);
    items.push(docItem(`document:${type}`, DOCUMENT_TYPES[type as DocumentType], match));
  }

  const hasPrincipal = business.people.some((p) => p.roles.some((r) => requirement.principalRoles.includes(r)));
  items.push({
    key: "people:principal",
    label: `At least one ${requirement.principalRoles.join(" or ")}`,
    done: hasPrincipal,
  });

  for (const person of business.people) {
    const id = String(person._id);
    items.push({ key: `person:${id}:bvn`, label: `${person.fullName}: BVN`, done: !!person.bvnEncrypted });
    items.push({ key: `person:${id}:idType`, label: `${person.fullName}: ID type`, done: !!person.idType });
    const idDoc = documents.find((d) => d.type === "government_id" && String(d.person) === id);
    items.push(docItem(`person:${id}:government_id`, `${person.fullName}: government-issued ID`, idDoc));
  }

  return { complete: items.every((i) => i.done), items };
}
