# LinkPay Business: design direction ("private ledger")

**Design read:** premium business banking for Nigerian SME owners and finance staff. The feel is classy and quiet, with one bold signature, closer to a private-bank statement than a SaaS template.

**Dials:** variance 6, motion 4, density 4.

Every colour, radius and font is a CSS variable in `src/app/globals.css`. Components never hard-code colour values.

## Signature

1. **Framed sheet.** The sidebar and header form a frame around a paper content sheet inset from it (`Sidebar variant="inset"`). In light mode the frame is pale slate with navy text. In dark mode it is deep navy with lime.
2. **The band.** On dashboard and admin pages the page title sits on a full-width band (soft navy tint in light, deep navy in dark) (`PageHeader` inside `[data-band]`). The first block after it overlaps the band's lower edge (`margin-top: -4.5rem`), which layers content over the frame.
3. **Display type.** Titles and key figures are set in Bricolage Grotesque at a large optical size with tight tracking (`type-display`).
4. **Lime.** Lime is the dark-mode brand (primary, active nav, progress). In both themes it appears on the logo tile and avatar fills. It is never used as text or as an icon on light surfaces; there, `primary` (navy) does that job.

## Type

| Role | Font | Notes |
| --- | --- | --- |
| Display (titles, hero figures, card titles) | **Bricolage Grotesque** (`font-display`, `type-display`) | `-0.035em` tracking, 1.02 line-height, width axis 92. |
| UI and body | **Geist** (`font-sans`) | 14px UI, 15px lead copy with relaxed leading. |
| Figures and IDs | **Geist Mono** (`font-mono`) | RC/BN, TIN, masked BVN, TOTP secret. |
| Money | Geist with the `figure` utility | Tabular numbers, formatted by `formatNGN()`. |

## Colour

| Token | Light | Dark |
| --- | --- | --- |
| Brand / `primary` | navy `#27394d` = `oklch(0.338 0.042 251.7)` | lime `oklch(0.841 0.238 128.85)` |
| `pop` (highlight) | lime | lime |
| `background` | cool paper `oklch(0.972 0.005 250)` | navy `#27394d` |
| `card` | `oklch(0.997 0.002 250)` | slate `oklch(0.392 0.036 244.3)` |
| `sidebar` (frame) | pale slate `oklch(0.955 0.009 250)`, navy text | deepest navy `oklch(0.255 0.038 252)`, light text |
| `brand-surface` (band, header) | soft navy tint `oklch(0.93 0.02 250)`, navy text | `oklch(0.29 0.04 252)`, light text |
| `ink` (auth band) | navy `oklch(0.338 0.042 251.7)`, light text, `ink-muted` secondary | deepest navy `oklch(0.255 0.038 252)` |

- Greys are cool slate (hue about 250) in both themes.
- Status colours are semantic only: success is green in light and lime in dark, warning is amber, destructive is red.
- Every text pair meets WCAG AA in both themes. The lowest pair is lime on `brand-subtle` in dark mode, at 4.8:1.

## Shape

`--radius: 0.625rem`.

- **Buttons:** pills. The one exception is the `pop` (lime) variant, reserved for actions on navy.
- **Inputs and selects:** 10px corners.
- **Dialogs:** 14px corners.
- **Cards, sheets and panels:** 18px corners (`surface`).
- **Status tags:** 6px corners (square-ish, not pills).
- **Avatars and tiles:** squircles (30% corner radius).

## Surfaces

- `surface` is a card fill with one soft navy-tinted shadow and no border.
- `surface-ink` is the navy panel.
- `grain` is a static noise pseudo-element, used only on navy surfaces (auth band, onboarding band).

## Layout

- **Dashboard:**
  - The sidebar has the branch switcher at the top, then the nav in groups (Home with no heading, then Banking, then Business), then Settings and a small wordmark at the bottom. It collapses to icons (Cmd/Ctrl+B) and becomes a slide-out sheet under 768px.
  - The header is **fixed**, not sticky (`PinnedHeader`). Its position comes from `--dashboard-header-left` and `--dashboard-header-width`, which the sidebar wrapper sets from its open state. It animates with the sidebar over the same 200ms.
  - Overscroll is off (`overscroll-behavior: none`). On sidebar pages the page background is the frame colour, so nothing different shows behind the app.
  - Below the header come the status banner (until verified), the band with the page title, then the overlapping content.
- **Onboarding:** a sticky navy header, a band showing the business name and a "done / total" figure with a lime progress bar, then one paper sheet holding the step rail and the form.
- **Auth (band and ledger, `AuthFrame`):** a solid navy `ink` band with grain runs edge to edge across the top (about half the viewport on desktop, a steady minimum height on every screen). It holds the lockup, a theme switch (light, dark, system), the page title in display type and one line. The form sits on one white `surface` sheet on the right that starts just under the header and drops through the band's lower edge (on phones it overlaps the band by 4rem). Under the band, on paper, a ledger of hairline rows states the screen's facts and marks the row you're on with a 6px "You're here" tag: ways to sign in (sign in, code, 2FA), the five numbered steps of opening an account (sign up, verify email), or how team access works (invites). Dead ends have no sheet: title, one sentence and one lime action in the band. No photography and no icon tiles on auth.
- **Admin (staff console):** the same framed sheet as the dashboard, with its own sidebar (review and directory groups with counts) and the band. Lists use the shared data table (`src/components/data-table/`): the status tabs, a search box and a Columns menu sit in the card; its state lives in the URL. On the detail page each section is its own `AdminSection` surface (never nested), with documents in a sticky panel on the right from `xl`.

## Branch and business switchers

The branch switcher sits at the top of the sidebar: the business name and the branch being shown, with "All branches" plus each branch in the menu, and "Manage branches" (or "View branches" for members without `branches.manage`). A member who sees only one branch gets that branch with nothing to switch.

When the user belongs to more than one business, a slim "Switch business" row with a count sits above it. Each business in its menu shows the user's role there.

## Team

- Members read as a table from md up and as cards below (one list, no duplicate markup). Roles are 6px status tags: the owner's is filled, others muted. Row actions live in a "…" menu that only appears where the rules allow it.
- The role picker is a set of choice cards built from `GET /api/team/roles`, each with one line generated from its permissions. The branch picker defaults to "All branches".
- Invite links use the auth frame (`AuthShell`) with a panel about team access instead of the verification checklist. Dead ends (expired, revoked, used, invalid) are an icon tile, a display title, one sentence and one next step.

## Public pay page (`/pay/[slug]`)

The payer meets the business, not LinkPay. Its colour (`--biz`, `--on-biz`, `--biz-text` from `business.palette`) fills a full-height panel on the left (a band on phones that the sheet overlaps by 4rem, the auth frame's grammar recoloured), with grain, the logo squircle, the link's pictures at their own aspect ratio, the title and the price in display type, and a vertical step timeline (done: filled node with a tick; current: ringed node; next: hollow number; the connector fills as steps finish). The work sits on one paper sheet. The transfer step is a perforated slip: kobo that identifies the transfer is highlighted in the business colour, the account number is grouped 3-3-4. Every tint is `color-mix` from `--biz` (`pay-brand` utility), so any colour works; accent-coloured text is never used in dark mode. Focus rings, selection and the main button take the business colour. Embeds use the compact header and the horizontal step track. Motion: the slip prints in (`slip-in`), the paid tick lands (`pop-in`). On a desktop the page never scrolls unless the form itself is taller than the screen: the panel is one screen tall, the picture takes the height left, and `short:` (desktop width, height ≤ 820px) tightens type and spacing.

## Motion

- `page-enter`: content rises 8px over 320ms on entry.
- `stagger`: children enter one after another, 50ms apart (set `--i` on each child).
- Buttons scale to 0.98 when pressed. Colours transition over 150 to 200ms.
- `prefers-reduced-motion` turns all of this off.

## States

- **Loading:** skeletons shaped like the final layout.
- **Empty:** a lime-accented icon tile, a display-type title, one sentence of copy and at most one action.
- **Errors:** shown inline under fields in forms.
- **Locked:** a lock icon plus a sentence explaining how to unlock the feature.

## Copy

- Plain Nigerian-business English, in sentence case.
- No em or en dashes and no exclamation marks.
- Never invent figures. Say what isn't there yet.
