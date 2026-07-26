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
 * (title / description / media_url / actions), which نبراس already fills as a
 * legacy fallback on every card. input_select choices ({title, value}) are
 * already within Chatwoot's allowed keys and pass through untouched.
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
      return safe;
    }),
  };
}

module.exports = { chatwootSafeAttrs, CW_CARD_KEYS };
