// Help screen questions: the web's web/src/lib/faq.ts in app wording (where things are on the phone), plus
// the app's own security questions. Every figure comes from the backend's rules; change both together.
import { LOCK_AFTER_BACKGROUND_MS, LOCK_AFTER_IDLE_MS } from "@/lib/security/app-lock";
import { MAX_ATTEMPTS } from "@/lib/security/passcode";

export type FaqQuestion = { q: string; a: string };
export type FaqTopic = { id: string; title: string; questions: FaqQuestion[] };

const awayMinutes = LOCK_AFTER_BACKGROUND_MS / 60_000;
const idleMinutes = LOCK_AFTER_IDLE_MS / 60_000;

export const FAQ: FaqTopic[] = [
  {
    id: "getting-started",
    title: "Getting started",
    questions: [
      {
        q: "Who can open an account?",
        a: "Any business registered with CAC in Nigeria: business names, partnerships, limited companies, cooperatives, companies limited by guarantee and incorporated trustees.",
      },
      {
        q: "What documents do I need?",
        a: "It depends on your business type. Every business adds its CAC certificate, TIN certificate and a utility bill or bank statement from the last 3 months, plus photo ID and BVN for each owner, partner, director or trustee. Limited companies also add a CAC status report and MEMART. The documents step shows exactly what yours needs, and you can take photos of them with your phone.",
      },
      {
        q: "What happens after I submit?",
        a: "Our review team checks your details and documents. Once your business is approved, your head office account number is set up and the rest of the app opens. If something needs fixing, we tell you exactly what, and you update those items and resubmit without starting over.",
      },
      {
        q: "What can I do before my business is verified?",
        a: "You can finish verification from Home, update your profile and turn on two-step verification. Payments, savings, invoices, branches and team open once your business is approved.",
      },
      {
        q: "Where is my money held?",
        a: "Business accounts are held with our partner bank. LinkPay Business is the app you use to run them.",
      },
    ],
  },
  {
    id: "accounts",
    title: "Accounts and branches",
    questions: [
      {
        q: "How do customers pay me?",
        a: "Share a branch's account number with Share on its Home card. Transfers from any Nigerian bank land in that account, show in Payments and add to your available balance.",
      },
      {
        q: "What is a branch?",
        a: "Each shop, warehouse or office can be a branch with its own account number, so you can see what each location brings in. Swipe between branch cards on Home. Your head office is created when your business is approved, and the owner or an admin adds more under More, Branches.",
      },
      {
        q: "Why is my available balance lower than my account balance?",
        a: "Available is what you can spend now. Money for transfers that are waiting for approval or being sent is held, and money in savings pockets or a Safelock is set aside. None of it counts as available until it's released.",
      },
      {
        q: "Can I hide my balances?",
        a: "Yes. Tap the eye beside \"Available balance\" on a Home card or on Account details to hide or show every balance at once.",
      },
      {
        q: "I run more than one business. Do I need another login?",
        a: "No. Use the same sign-in for every business you own or have been invited to, and switch between them from More, Switch business.",
      },
    ],
  },
  {
    id: "transfers",
    title: "Transfers",
    questions: [
      {
        q: "Who can I send money to?",
        a: "Any Nigerian bank account, another business on LinkPay or one of your own branches. We check the account name before you send, and tell you when the account belongs to a LinkPay business or one of your branches.",
      },
      {
        q: "What does a transfer cost?",
        a: "The fee is shown on the review step before you confirm. It includes the ₦50 stamp duty charged on transfers of ₦10,000 or more. Moving money into savings pockets or a Safelock is free.",
      },
      {
        q: "How much can I send?",
        a: "From ₦1 up to ₦100 million in one transfer, as long as the amount and fee are within the branch's available balance.",
      },
      {
        q: "Can I pay many people at once?",
        a: "Bulk transfers are on the web dashboard for now: upload a CSV file or paste up to 200 rows, check them, then send them together.",
      },
      {
        q: "Why is my transfer waiting?",
        a: "Your business has an approval rule, so someone else has to approve it before it's sent. The transfer shows who it's waiting for, and the money stays held until it's approved or declined.",
      },
    ],
  },
  {
    id: "approvals",
    title: "Fund approvals",
    questions: [
      {
        q: "How do approval rules work?",
        a: "The owner or an admin chooses one: no approval, approve every transfer, approve transfers above an amount, or approval levels by amount. With levels, you set up to 5 amount bands, each with 1 to 3 levels of named approvers who approve in order.",
      },
      {
        q: "Can I approve my own transfer?",
        a: "No. Someone other than the person who prepared it always approves it, and one person can't approve two levels of the same transfer.",
      },
      {
        q: "Do Finance members need approval even without a rule?",
        a: "Yes. Transfers prepared by someone who can't approve transfers always need another member's approval.",
      },
      {
        q: "Where do I see what's waiting for me?",
        a: "In Payments, switch to Transfers and open Fund approvals. It shows everything pending and marks the ones waiting for you. Open a transfer to approve or decline it with a note.",
      },
    ],
  },
  {
    id: "savings",
    title: "Savings and Safelock",
    questions: [
      {
        q: "What is a savings pocket?",
        a: "A named pot inside a branch's account, for things like VAT, payroll or rent. The money stays in the branch's account but is set aside, so transfers can't spend it. Each branch can have up to 20 open pockets. Find them under Savings on Home.",
      },
      {
        q: "Can I take money out of a pocket?",
        a: "Yes, at any time. Withdrawing moves it straight back to the branch's available balance. Closing a pocket returns everything left in it.",
      },
      {
        q: "How does auto-save work?",
        a: "A pocket can keep a percentage or a fixed amount of every payment that comes into its branch. Payments from your own branches are skipped, and with a target it stops once the target is reached.",
      },
      {
        q: "What is a Safelock?",
        a: "A fixed amount locked away until a date you choose, between 10 and 1,000 days from today. The smallest lock is ₦1,000, and each branch can run up to 50 at once. On the unlock date the money goes back to the branch's available balance by itself.",
      },
      {
        q: "Can I break a Safelock early?",
        a: "No. Once it's locked you can't take money out, add to it or change the unlock date, so lock only money you won't need before then. You can rename it.",
      },
      {
        q: "Do pockets or Safelocks earn interest?",
        a: "Not yet. Both keep your money set aside without interest for now.",
      },
    ],
  },
  {
    id: "invoices",
    title: "Invoices",
    questions: [
      {
        q: "How do I send an invoice?",
        a: "Create it in Invoices with your items, any discount and VAT (7.5% by default), then send it by email with a PDF attached, or mark it as sent and share its link. Your customer can open the link without signing in.",
      },
      {
        q: "How do invoices get marked as paid?",
        a: "Ask customers to put the invoice number, like INV-0042, in their transfer narration and we match the payment for you. You can also link a payment yourself or record cash, POS or cheque payments by hand, including part payments.",
      },
      {
        q: "Do customers get reminders?",
        a: "Yes, if reminders are on: 3 days before the due date, on the day, then 3 and 10 days after. You can also send one yourself, once an hour.",
      },
      {
        q: "Can invoices carry my logo?",
        a: "Yes. Add your logo, accent colour and invoice defaults under More, Invoice branding.",
      },
    ],
  },
  {
    id: "payment-links",
    title: "Payment links",
    questions: [
      {
        q: "What is a payment link?",
        a: "A page with its own address that anyone can pay you through, for a product, a deposit, a ticket or a donation. Set a fixed price or let the customer choose (with a smallest amount if you like), ask for a phone number and up to 5 questions of your own, and stop it on a date or after a number of payments. Owners, admins and finance members can create them.",
      },
      {
        q: "How do customers pay through a link?",
        a: "By bank transfer from any Nigerian bank, into the branch's account. Each customer is shown an exact amount to send, the price plus a few kobo, and a reference starting LP-. Either one lets us match their transfer, so the payment shows as paid within a minute or so of landing and the customer gets a receipt by email.",
      },
      {
        q: "What if a customer sends a round amount without the reference?",
        a: "Open the payment and choose Link a payment. We show transfers into that account since they started that look like theirs, and you pick the right one. If they sent less than the price, it shows as part paid.",
      },
      {
        q: "Can I put a pay button on my website?",
        a: "Yes. On the web dashboard, each link's page has code for a pay button that opens the checkout over your page, for the checkout shown in your page, or for opening it from your own JavaScript with your order number. You can limit a link to your own websites. Before handing over goods, check the payment from your server with the token the page gives you.",
      },
      {
        q: "Can I change or delete a link?",
        a: "You can edit it at any time; changes apply to new payments, and anyone already paying keeps their amount. Turn a link off to stop new payments. A link can only be deleted if nobody has started paying through it.",
      },
    ],
  },
  {
    id: "team",
    title: "Team and access",
    questions: [
      {
        q: "What can each role do?",
        a: "Owner and Admin can do everything. Finance sees balances, prepares transfers, manages invoices and moves money in savings. Approver sees balances and approves transfers. Viewer only sees balances and payments.",
      },
      {
        q: "Can I limit someone to certain branches?",
        a: "Yes. Finance, Approver and Viewer members can be limited to the branches you pick. Owners and admins always cover every branch.",
      },
      {
        q: "How do invites work?",
        a: "Invite people by email from Team. The link works for 7 days, and you can resend or revoke it while it's pending.",
      },
      {
        q: "Can I hand over ownership?",
        a: "Not yet. For now the person who opened the account stays the owner.",
      },
    ],
  },
  {
    id: "security",
    title: "Security and sign-in",
    questions: [
      {
        q: "When does the app lock?",
        a: `After ${awayMinutes === 1 ? "1 minute" : `${awayMinutes} minutes`} away from the app or ${idleMinutes} minutes without a tap. Unlock with your passcode, or Face ID or a fingerprint if you've turned it on under More. You can also lock it yourself with Lock now.`,
      },
      {
        q: "I forgot my passcode. What do I do?",
        a: `Tap "Forgot passcode?" on the lock screen, then sign in again with your email and password and choose a new passcode. After ${MAX_ATTEMPTS} wrong tries the app signs this phone out for you.`,
      },
      {
        q: "What is the transaction PIN?",
        a: "4 digits LinkPay asks for before money is sent, approved, locked in a Safelock or taken out of savings, and before team access or the approval rule changes. LinkPay checks it, so it's the same here and on the web, and it's separate from this phone's passcode. Set or change it under More, Transaction PIN.",
      },
      {
        q: "I forgot my transaction PIN, or it's locked.",
        a: "5 wrong tries in a row lock it for 30 minutes. Open More, Transaction PIN and choose Forgot PIN or Reset PIN: we email you a code, and with it and your password you choose a new PIN. That ends the lock too.",
      },
      {
        q: "I lost my phone. How do I protect my account?",
        a: "Sign in on another phone, open More, Signed-in devices and sign the lost phone out. That also turns off biometric sign-in on it.",
      },
      {
        q: "How do I turn on two-step verification?",
        a: "Open More, Two-step verification and choose an authenticator app or a code sent to your email. You'll then confirm each sign-in with a code.",
      },
      {
        q: "I forgot my password. What do I do?",
        a: "Choose to sign in with a code sent to your email instead. Password reset isn't available yet; email support if you're stuck.",
      },
      {
        q: "How do I know when money moves?",
        a: "Turn on push notifications under More. You'll hear about money in, transfers sent or waiting for your approval, invoices paid, savings milestones, verification updates and new sign-ins. The bell on Home keeps them all.",
      },
    ],
  },
];
