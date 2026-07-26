/**
 * Agent takeover — when a human agent assigns a Chatwoot conversation to
 * themselves, Majed (Nabras/Botpress) must go silent so the two never talk over
 * each other. Kept as its own module so both the payload parsing and the small
 * state machine are unit-tested without spinning up the server.
 *
 * Independent of conversation status on purpose: an agent can grab a "pending"
 * chat without replying first, and status alone would not catch that.
 */

// Pull the assignee id out of any shape Chatwoot uses for an assignment change:
//   - assignee_changed:      top-level `assignee`, or `meta.assignee`
//   - conversation_updated:  `changed_attributes[].assignee_id.current_value`
// Returns {present, id}: present=false means the payload said nothing about
// assignment (so the caller leaves the current state alone); id=null means
// explicitly unassigned.
function extractAssignee(p) {
  const idOf = (v) => {
    if (v == null) return null;
    if (typeof v === 'object') return v.id != null ? Number(v.id) : null;
    return Number(v) || null;
  };
  if (p.assignee !== undefined) return { present: true, id: idOf(p.assignee) };
  const metaAssignee = p.conversation?.meta?.assignee ?? p.meta?.assignee;
  if (metaAssignee !== undefined) return { present: true, id: idOf(metaAssignee) };
  for (const ch of p.changed_attributes || []) {
    if (ch && Object.prototype.hasOwnProperty.call(ch, 'assignee_id')) {
      return { present: true, id: idOf(ch.assignee_id.current_value) };
    }
  }
  return { present: false, id: null };
}

class Takeover {
  constructor(enabled = true) {
    this.enabled = enabled;
    this.set = new Set(); // cwConvId (string)
  }

  // Apply an assignment change. Returns true if the takeover state changed.
  apply(convId, assigneeId) {
    if (!this.enabled) return false;
    const id = String(convId);
    if (assigneeId) {
      if (this.set.has(id)) return false;
      this.set.add(id);
      return true;
    }
    if (!this.set.has(id)) return false;
    this.set.delete(id);
    return true;
  }

  // A finished (resolved) conversation drops its takeover, so that if the
  // customer returns and it is revived, Majed answers again.
  clear(convId) {
    this.set.delete(String(convId));
  }

  isAssigned(convId) {
    return this.set.has(String(convId));
  }
}

module.exports = { extractAssignee, Takeover };
