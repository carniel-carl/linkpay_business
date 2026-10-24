// Help page questions. Every figure here comes from the backend's rules (backend/src/config, services);
// change both together. The mobile app keeps its own copy in mobile/src/lib/faq.ts with app wording.

export type FaqQuestion = { q: string; a: string }
export type FaqTopic = { id: string; title: string; questions: FaqQuestion[] }

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
        a: "It depends on your business type. Every business adds its CAC certificate, TIN certificate and a utility bill or bank statement from the last 3 months, plus photo ID and BVN for each owner, partner, director or trustee. Limited companies also add a CAC status report and MEMART. The documents step shows exactly what yours needs.",
      },
      {
        q: "What happens after I submit?",
        a: "Our review team checks your details and documents. Once your business is approved, your head office account number is set up and the rest of the dashboard opens. If something needs fixing, we tell you exactly what, and you update those items and resubmit without starting over.",
      },
      {
        q: "What can I do before my business is verified?",
        a: "You can finish verification, update your profile and turn on two-step verification. Accounts, transfers, savings, invoices, branches and team open once your business is approved.",
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
        a: "Share a branch's account number. Transfers from any Nigerian bank land in that account, show in Transactions and add to your available balance.",
      },
      {
        q: "What is a branch?",
        a: "Each shop, warehouse or office can be a branch with its own account number, so you can see what each location brings in. Your head office is created when your business is approved. The owner or an admin adds and edits branches.",
      },
      {
        q: "Why is my available balance lower than my account balance?",
        a: "Available is what you can spend now. Money for transfers that are waiting for approval or being sent is held, and money in savings pockets or a Safelock is set aside. None of it counts as available until it's released.",
      },
      {
        q: "Can I hide my balances?",
        a: "Yes. Select the eye beside \"Available balance\" on Home or Accounts to hide or show every balance at once.",
      },
      {
        q: "I run more than one business. Do I need another login?",
        a: "No. Use the same sign-in for every business you own or have been invited to, and switch between them from the top of the sidebar.",
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
        a: "Yes. Use Bulk transfer to pay up to 200 people from one account: pick saved beneficiaries, upload or paste a CSV of account numbers, banks and amounts, or both. You check them on one screen, then send them together.",
      },
      {
        q: "What does the bulk transfer check show?",
        a: "Before anything is sent, we check every new account with its bank and show the name it gives, then the fees, the total from the account and whether it needs approval. If any row has a problem, nothing is sent until it's fixed or removed. If an account's name changes between your check and sending, nothing is sent either: we show the new name so you can accept it or remove that row. You confirm with your transaction PIN.",
      },
      {
        q: "Why is my transfer waiting?",
        a: "Your business has an approval rule, so someone else has to approve it before it's sent. The transfer shows who it's waiting for, and the money stays held until it's approved or declined.",
      },
    ],
  },
  {
    id: "payouts",
    title: "Beneficiaries and payout lists",
    questions: [
      {
        q: "What is a beneficiary?",
        a: "Someone you pay often, saved once for your whole team. We check the account with its bank when you save it and keep the name it gives, so paying them later needs no new check. Choose them in Send money or Bulk transfer, or tick Save to beneficiaries when you send to a new account. A business can save up to 2,000.",
      },
      {
        q: "Can I change or delete a beneficiary?",
        a: "You can change the nickname. To pay a different account, save it as a new beneficiary. Deleting one keeps past payments to them in Transfers, but you can't delete someone a payout list still pays: take them off the list first.",
      },
      {
        q: "Can I add many beneficiaries at once?",
        a: "Yes. On Beneficiaries, choose Import and upload or paste a CSV of up to 200 accounts: account number, bank and an optional nickname. Each account is checked with its bank and saved, and every line shows what happened. If the bank can't check some of them just then, the others are still saved, and you can check those again a few minutes later.",
      },
      {
        q: "What is a payout list?",
        a: "A saved bulk payment, like Monthly salaries: beneficiaries with an amount and an optional narration each, and the account it's usually paid from. Paying it makes an ordinary bulk transfer, with the same check, PIN and approval rules. You can change the amounts for one payment only, or save them to the list. You can also save a past bulk transfer as a list. A business can keep up to 100 lists of up to 200 people.",
      },
      {
        q: "Who can see and pay payout lists?",
        a: "Anyone who can see balances sees the lists, and members who can prepare transfers create, edit and pay them. Someone limited to certain branches sees only the lists for those branches and lists with no account set.",
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
        a: "Open Fund approvals. It shows everything pending, marks the ones waiting for you and lets you approve or decline with a note.",
      },
      {
        q: "How do I approve a bulk transfer?",
        a: "Find it in Fund approvals, under Bulk transfers waiting for you, or open it in Transfers. Approve, which shows how many of its transfers are waiting for you, approves them all with your PIN. Reject declines the same ones, with an optional note. Any at another approval level, or that you prepared, are left for the right person.",
      },
    ],
  },
  {
    id: "savings",
    title: "Savings and Safelock",
    questions: [
      {
        q: "What is a savings pocket?",
        a: "A named pot inside a branch's account, for things like VAT, payroll or rent. The money stays in the branch's account but is set aside, so transfers can't spend it. Each branch can have up to 20 open pockets.",
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
        a: "Create it with your items, any discount and VAT (7.5% by default), then send it by email with a PDF attached, or mark it as sent and share its link. Your customer can open the link without signing in.",
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
        a: "Yes. Add your logo, accent colour and invoice defaults in Settings, Invoice branding.",
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
        a: "Open the payment on the link's page and choose Link a payment. We show transfers into that account since they started that look like theirs, and you pick the right one. If they sent less than the price, it shows as part paid.",
      },
      {
        q: "Can I put a pay button on my website?",
        a: "Yes. Each link's page has code for a pay button that opens the checkout over your page, for the checkout shown in your page, or for opening it from your own JavaScript with your order number. You can limit a link to your own websites. Before handing over goods, check the payment from your server with the token the page gives you.",
      },
      {
        q: "What if someone pays after a link's limit is reached?",
        a: "The payment is still recorded, because the money has arrived, and it's marked Over limit. We tell your team so you can refund it or honour it. The payer's receipt still says paid.",
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
        q: "How do I turn on two-step verification?",
        a: "Go to Settings, Security and choose an authenticator app or a code sent to your email. You'll then confirm each sign-in with a code.",
      },
      {
        q: "What is the transaction PIN?",
        a: "Four digits, separate from your password, that confirm money leaving and security changes: transfers, bulk transfers, payout lists, approvals, a new Safelock, taking money out of or closing a pocket, the approval rule and team changes. You set it with your password the first time you need it, or in Settings, Security. It's the same in every business you're part of.",
      },
      {
        q: "I forgot my PIN, or it's locked. What do I do?",
        a: "After 5 wrong PINs in a row it's locked for 30 minutes, and we email you. To reset it, go to Settings, Security and choose Forgot your PIN? or Reset PIN. We email you a 6-digit code, and you enter it with your password and a new PIN. Resetting also ends the lock.",
      },
      {
        q: "I forgot my password. What do I do?",
        a: "Choose to sign in with a code sent to your email instead. Password reset isn't available yet; email support if you're stuck.",
      },
      {
        q: "How do I know when money moves?",
        a: "The bell at the top of the dashboard tells you as things happen: money in, transfers sent or waiting for your approval, invoices paid, savings milestones, verification updates and new sign-ins to your account. The mobile app can also send them as push notifications.",
      },
    ],
  },
]
