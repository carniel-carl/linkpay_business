import { KYB_REQUIREMENTS } from "../config/kyb";
import { BranchModel, type BranchDocument } from "../models/Branch";
import { BusinessModel, type BusinessDocument } from "../models/Business";
import { UserModel } from "../models/User";
import { VirtualAccountModel } from "../models/VirtualAccount";
import { decrypt } from "../utils/crypto";
import { liquifia, LiquifiaError, newIdempotencyKey, type LiquifiaCustomerInput } from "./liquifia/client";

// Liquifia gives one NGN account per customer, so the head office uses the business's customer and
// every other branch gets a customer of its own.
const customerReference = (business: BusinessDocument, branch?: BranchDocument) =>
  branch && !branch.isHeadOffice ? `biz${business.id}br${branch.id}` : `biz${business.id}`;

// Liquifia customers are modelled on people (first/last name). Splitting the business name
// keeps the full name intact when the provider joins them, e.g. for the account name.
function splitName(name: string) {
  const [first, ...rest] = name.trim().split(/\s+/);
  return { first_name: first!, last_name: rest.join(" ") || "Business" };
}

/** Converts local Nigerian numbers (080...) to international format; drops anything unrecognised. */
function toInternationalPhone(phone?: string | null) {
  const digits = phone?.replace(/[^\d+]/g, "") ?? "";
  if (/^\+234\d{10}$/.test(digits)) return digits;
  if (/^234\d{10}$/.test(digits)) return `+${digits}`;
  if (/^0\d{10}$/.test(digits)) return `+234${digits.slice(1)}`;
  return undefined;
}

async function buildCustomerInput(business: BusinessDocument, branch?: BranchDocument): Promise<LiquifiaCustomerInput> {
  const owner = await UserModel.findById(business.owner).select("email");
  const isBranch = !!branch && !branch.isHeadOffice;
  const principalRoles = KYB_REQUIREMENTS[business.type].principalRoles;
  const principal = business.people.find((p) => p.bvnEncrypted && p.roles.some((r) => principalRoles.includes(r)));

  return {
    customer_reference: customerReference(business, branch),
    // The account name payers see, e.g. "Acme Trading Ltd Kano branch".
    ...splitName(isBranch ? `${business.name} ${branch.name}` : business.name),
    email: business.email ?? owner?.email,
    phone_number: toInternationalPhone(business.phone),
    // Liquifia doesn't require a BVN (confirmed by the product owner, 2026-10-20). Only the business's own
    // customer carries the principal's BVN, so the same BVN is never sent on several customers.
    ...(!isBranch && principal?.bvnEncrypted && { bvn: decrypt(principal.bvnEncrypted) }),
  };
}

/** The Liquifia customer that owns the branch's account: the business's for the head office, else the branch's own. */
async function ensureCustomer(business: BusinessDocument, branch?: BranchDocument): Promise<string> {
  const owner = branch && !branch.isHeadOffice ? branch : business;
  if (owner.liquifia?.customerId) return owner.liquifia.customerId;

  const reference = customerReference(business, branch);
  let customerId: string;
  try {
    customerId = (await liquifia.createCustomer(await buildCustomerInput(business, branch))).id;
  } catch (err) {
    // A previous attempt may have created the customer before failing; reuse it.
    const existing = err instanceof LiquifiaError && err.status === 409 ? await liquifia.findCustomerByReference(reference) : undefined;
    if (!existing) throw err;
    customerId = existing.id;
  }

  owner.set("liquifia.customerId", customerId);
  if (owner !== business) {
    // A new customer needs a new key: a key already used against another customer (branches created
    // before per-branch customers used the business's) would make Liquifia replay that customer's account.
    owner.set("liquifia.virtualAccountIdempotencyKey", newIdempotencyKey());
  }
  await owner.save();
  return customerId;
}

/**
 * Returns the business's head office, creating it at the registered address if it doesn't exist.
 * Businesses approved before branches existed get their provisioning state and account moved onto it.
 */
export async function ensureHeadOffice(business: BusinessDocument): Promise<BranchDocument> {
  const existing = await BranchModel.findOne({ business: business._id, isHeadOffice: true });
  if (existing) return existing;

  let headOffice: BranchDocument;
  try {
    headOffice = await BranchModel.create({
      business: business._id,
      name: "Head office",
      isHeadOffice: true,
      address: business.toObject().address,
      liquifia: {
        accountStatus: business.liquifia?.accountStatus ?? "not_started",
        lastError: business.liquifia?.lastError,
        virtualAccountIdempotencyKey: business.liquifia?.virtualAccountIdempotencyKey,
      },
    });
  } catch (err: any) {
    // Two requests raced to create it; the unique index let only one through.
    if (err?.code !== 11000) throw err;
    return (await BranchModel.findOne({ business: business._id, isHeadOffice: true }))!;
  }

  await VirtualAccountModel.updateMany(
    { business: business._id, branch: { $exists: false } },
    { branch: headOffice._id },
  );
  return headOffice;
}

/**
 * Creates the branch's NGN virtual account (funds held in the account) under its Liquifia customer.
 * Safe to call repeatedly: finished steps are skipped and retries reuse the same idempotency key.
 * The head office's status is mirrored onto the business, which clients read as the overall account status.
 */
export async function provisionBranchAccount(branchId: unknown) {
  const branch = await BranchModel.findById(branchId);
  if (!branch) throw new Error(`Branch ${branchId} not found`);
  const business = await BusinessModel.findById(branch.business);
  if (!business) throw new Error(`Business ${branch.business} not found`);

  const existing = await VirtualAccountModel.findOne({ branch: branch._id });
  if (existing) return existing;

  const setStatus = async (accountStatus: string, lastError?: string) => {
    branch.set({ "liquifia.accountStatus": accountStatus, "liquifia.lastError": lastError });
    await branch.save();
    if (branch.isHeadOffice) {
      business.set({ "liquifia.accountStatus": accountStatus, "liquifia.lastError": lastError });
      await business.save();
    }
  };

  if (!branch.liquifia?.virtualAccountIdempotencyKey) {
    branch.set("liquifia.virtualAccountIdempotencyKey", newIdempotencyKey());
  }
  await setStatus("pending");

  try {
    const customerId = await ensureCustomer(business, branch);
    const va = await liquifia.createVirtualAccount(
      customerId,
      { country: "NG", currency: "NGN", settlement_mode: "held" },
      branch.liquifia!.virtualAccountIdempotencyKey!,
    );

    // Liquifia returns the customer's existing NGN account instead of opening a second one
    // (seen on the live API, not in the docs), so the account may already belong to another branch.
    const taken = await VirtualAccountModel.findOne({ providerAccountId: va.id, branch: { $ne: branch._id } });
    if (taken) {
      throw new Error(
        `Liquifia returned account ${va.id} (${va.account_number}), which already belongs to branch ${taken.branch}. ` +
          "Liquifia gives one NGN account per customer, so each branch needs its own customer.",
      );
    }

    const account = await VirtualAccountModel.create({
      business: business._id,
      branch: branch._id,
      label: branch.isHeadOffice ? "Main account" : branch.name,
      providerAccountId: va.id,
      providerCustomerId: customerId,
      accountNumber: va.account_number,
      accountName: va.account_name,
      bankName: va.bank_name,
      status: va.status ?? "active",
      providerData: va,
    });
    await setStatus("active");
    return account;
  } catch (err) {
    const message = err instanceof LiquifiaError ? `${err.status} ${err.code}: ${err.message}` : String(err);
    await setStatus("failed", message);
    throw err;
  }
}

/** Sets up an approved business: its head office and the head office's account. */
export async function provisionBusinessAccount(businessId: unknown) {
  const business = await BusinessModel.findById(businessId);
  if (!business) throw new Error(`Business ${businessId} not found`);
  const headOffice = await ensureHeadOffice(business);
  return provisionBranchAccount(headOffice._id);
}
