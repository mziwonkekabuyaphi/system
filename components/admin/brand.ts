// components/admin/brand.ts
//
// The tenant's dashboard colour as Tailwind class strings, so buttons, switches
// and selected cards always match the sidebar:
//   - tenant has custom colours  -> var(--sb-bg) / var(--sb-text), set on the
//                                   AdminView root by sidebarStyleVars()
//   - otherwise                  -> the standard bg-admin-sidebar /
//                                   text-admin-on-sidebar classes the sidebar uses
//
// The custom case is switched with a group-data variant on the AdminView root
// (class "group/admin" + data-brand="custom"), so nothing here is hardcoded and
// no JavaScript runs per component. Keep every class a full literal string:
// Tailwind only generates what it can find in the source.

/** Solid fill (primary buttons, switch "on"). */
export const BRAND_BG = "bg-admin-sidebar group-data-[brand=custom]/admin:bg-[var(--sb-bg)]"

/** Text/icon colour that is readable ON the fill above. */
export const BRAND_ON = "text-admin-on-sidebar group-data-[brand=custom]/admin:text-[color:var(--sb-text)]"

/** Brand-coloured text on a light surface (selected option titles, labels). */
export const BRAND_TEXT = "text-admin-sidebar group-data-[brand=custom]/admin:text-[color:var(--sb-bg)]"

/** Border + ring for a selected option card. */
export const BRAND_SELECTED =
  "border-admin-sidebar ring-1 ring-admin-sidebar group-data-[brand=custom]/admin:border-[color:var(--sb-bg)] group-data-[brand=custom]/admin:ring-[color:var(--sb-bg)]"

/** Input focus border. */
export const BRAND_FOCUS_BORDER =
  "focus:border-admin-sidebar group-data-[brand=custom]/admin:focus:border-[color:var(--sb-bg)]"

/** Border in the brand colour (selected pills/tiles, "on" switch track). */
export const BRAND_BORDER = "border-admin-sidebar group-data-[brand=custom]/admin:border-[color:var(--sb-bg)]"

/** Focus ring (box-shadow ring) on inputs. */
export const BRAND_FOCUS_RING = "focus:ring-admin-sidebar group-data-[brand=custom]/admin:focus:ring-[color:var(--sb-bg)]"

/** Keyboard focus ring on buttons / switches. */
export const BRAND_FOCUS_VISIBLE_RING =
  "focus-visible:ring-admin-sidebar group-data-[brand=custom]/admin:focus-visible:ring-[color:var(--sb-bg)]"

/** Keyboard focus outline on clickable rows. */
export const BRAND_FOCUS_OUTLINE =
  "focus-visible:outline-admin-sidebar group-data-[brand=custom]/admin:focus-visible:outline-[color:var(--sb-bg)]"

/** A disabled brand-filled button. Needed because the custom-colour fill above is more specific
 *  than a plain disabled: class, so without this a disabled button would stay fully branded. */
export const BRAND_BTN_DISABLED =
  "disabled:bg-stone-300 disabled:text-stone-500 group-data-[brand=custom]/admin:disabled:bg-stone-300 group-data-[brand=custom]/admin:disabled:text-stone-500"
