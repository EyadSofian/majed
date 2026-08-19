/**
 * Chatwoot card sanitiser.
 *
 * Chatwoot validates a card message's `items` against a fixed key set and 422s
 * the ENTIRE message on any extra key. نبراس's cards carry rich fields
 * (course_id, price_display, instructor, options, package_id, …) for the widget,
 * which makes the persisted Chatwoot copy fail — the live SSE copy is fine, but
 * the card is then missing from history and the agent's view, and the log fills
 * with "Content attributes contains invalid keys for items".
 *
 * The widget keeps the full item; Chatwoot gets only the keys it accepts
 * (title / description / media_url / actions). input_select choices
 * ({title, value}) are already within Chatwoot's allowed keys and pass through
 * untouched.
 *
 * `actions` is not merely allowed, it is REQUIRED — and it is not filled on
 * every card. An instructor card has nothing to buy, so it carries none, and
 * Chatwoot 422s the whole message:
 *
 *   cw outgoing write failed:
 *     'Validation failed: Content attributes contains items missing actions'
 *
 * The customer had just asked «مين المحاضر». The live SSE copy reached the
 * widget, so this only showed up as a red line in the bridge log and a card
 * missing from history and from the agent's view. An empty array satisfies
 * the validator and renders as a card with no buttons, which is what an
 * instructor card is.
 */
const CW_CARD_KEYS = ['title', 'description', 'media_url', 'actions'];

function chatwootSafeAttrs(attrs) {
  if (!attrs || !Array.isArray(attrs.items)) return attrs;
  return {
    ...attrs,
    items: attrs.items.map((it) => {
      if (it && it.value !== undefined && it.kind === undefined) return it; // choice
      const safe = {};
      for (const k of CW_CARD_KEYS) if (it && it[k] !== undefined) safe[k] = it[k];
      if (!Array.isArray(safe.actions)) safe.actions = [];
      return safe;
    }),
  };
}

module.exports = { chatwootSafeAttrs, CW_CARD_KEYS };
