// File: lib/services/orders/orders.types.tap-additions.ts
//
// MERGE INTO lib/services/orders/orders.types.ts (this is not a module of its own).
// I haven't seen your current orders.types.ts, so everything below is additive: paste each block,
// skipping any export your file already has. Nothing here changes an existing name.

// ---------------------------------------------------------------------------
// 1) Constants: tap-list row ids (WhatsApp returns them as message.interactiveId)
// ---------------------------------------------------------------------------
// The shared "or_" prefix is what action-router.ts uses to keep these taps out of its reset-word check
// (a product called "Stop & Go" must not reset the chat).
export const LIST_TAP_PREFIX = 'or_';
export const TAP_CATEGORY = 'or_cat:'; // + index into pendingCategories
export const TAP_FULL_MENU = 'or_cat_all';
export const TAP_PRODUCT = 'or_prod:'; // + product id (re-read fresh, so a stale list never adds the wrong item)
export const TAP_MORE = 'or_more:'; // + page (which list depends on the state)
export const TAP_MENU = 'or_menu';
export const TAP_CART = 'or_cart';
export const TAP_TRACK = 'or_track';
export const TAP_SAME_AGAIN = 'or_again';
export const TAP_REMOVE = 'or_rm:'; // + product id
export const TAP_REMOVE_ALL = 'or_rm_all';
export const TAP_REMOVE_BACK = 'or_rm_back';
export const TAP_PAY = 'or_pay:'; // + wallet | card | cash
export const TAP_LATER = 'or_later';
export const TAP_TIME = 'or_time:'; // + index into pendingTimes
export const TAP_TIME_TYPE = 'or_time_type';
// NEW with collection / delivery / dine-in:
export const TAP_FULFIL = 'or_ful:'; // + collection | delivery | dine_in
export const TAP_AREA = 'or_area:'; // + index into pendingAreaIds

// Quantity: "1" and "2" are read as the number they say; "3 or more" asks for a typed number.
export const QUANTITY_MORE_BUTTON = '3 or more';
export const QUANTITY_BUTTONS = ['1', '2', QUANTITY_MORE_BUTTON];

// ---------------------------------------------------------------------------
// 2) One row of the category list: a group of the tenant's categories shown as a single choice
// ---------------------------------------------------------------------------
export interface PendingCategory {
  label: string;
  /** product_categories.id values to fetch products for. */
  categoryIds: string[];
  /** First category key in the group. */
  key: string;
  /** Available products in the group, shown under its name in the menu list. */
  count?: number;
}

// ---------------------------------------------------------------------------
// 3) Fields to add to OrdersStateData (skip any it already declares)
// ---------------------------------------------------------------------------
//   /** Numbered category list currently shown (ORDER_STATE_AWAITING_CATEGORY). */
//   pendingCategories?: PendingCategory[];
//   /** What "Same as last time" would add, kept so the menu list can be re-shown. */
//   sameAgain?: string | null;
//   /** Title of the product list last shown, so "Continue Shopping" and "More ▸" can re-show it. */
//   listTitle?: string;
//   /** Valid pick-up/delivery times offered by the "later" list (ISO + label), so a tap maps back to one. */
//   pendingTimes?: Array<{ iso: string; label: string }>;
//   category?: ProductCategory;
//   /** Delivery areas offered on the area list, by id, so a tap on row N maps back to one. (You already have this.) */
//   pendingAreaIds?: string[];
