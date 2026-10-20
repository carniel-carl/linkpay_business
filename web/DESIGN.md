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
- `grain` is a static noise pseudo-element, used only on navy panels (auth side panel, onboarding band).

## Layout

- **Dashboard:**
  - The sidebar has the branch switcher at the top, then the Banking nav, then Settings and a small wordmark at the bottom. It collapses to icons (Cmd/Ctrl+B) and becomes a slide-out sheet under 768px.
  - The header is **fixed**, not sticky (`PinnedHeader`). Its position comes from `--dashboard-header-left` and `--dashboard-header-width`, which the sidebar wrapper sets from its open state. It animates with the sidebar over the same 200ms.
  - Overscroll is off (`overscroll-behavior: none`). On sidebar pages the page background is the frame colour, so nothing different shows behind the app.
  - Below the header come the status banner (until verified), the band with the page title, then the overlapping content.
- **Onboarding:** a sticky navy header, a band showing the business name and a "done / total" figure with a lime progress bar, then one paper sheet holding the step rail and the form.
- **Auth:** the form sits on paper on the left; a navy panel with grain on the right shows the headline and what verification needs.
- **Admin (staff console):** the same framed sheet as the dashboard, with its own sidebar (review and directory groups with counts) and the band. Lists use the shared data table (`src/components/data-table/`): the status tabs, a search box and a Columns menu sit in the card; its state lives in the URL. On the detail page each section is its own `AdminSection` surface (never nested), with documents in a sticky panel on the right from `xl`.

## Branch and business switchers

The branch switcher sits at the top of the sidebar: the business name and the branch being shown, with "All branches" plus each branch in the menu, and "Manage branches" (or "View branches" for members without `branches.manage`). A member who sees only one branch gets that branch with nothing to switch.

When the user belongs to more than one business, a slim "Switch business" row with a count sits above it. Each business in its menu shows the user's role there.

## Team

- Members read as a table from md up and as cards below (one list, no duplicate markup). Roles are 6px status tags: the owner's is filled, others muted. Row actions live in a "…" menu that only appears where the rules allow it.
- The role picker is a set of choice cards built from `GET /api/team/roles`, each with one line generated from its permissions. The branch picker defaults to "All branches".
- Invite links use the auth frame (`AuthShell`) with a panel about team access instead of the verification checklist. Dead ends (expired, revoked, used, invalid) are an icon tile, a display title, one sentence and one next step.

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
