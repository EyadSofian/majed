/**
 * Tracks human takeover independently from Chatwoot conversation status.
 * An agent may self-assign a pending conversation before replying; status-only
 * gating misses that case.
 */
function extractAssignee(payload) {
  const idOf = (value) => {
    if (value == null) return null;
    if (typeof value === 'object') return value.id == null ? null : Number(value.id);
    return Number(value) || null;
  };

  if (payload.assignee !== undefined) return { present: true, id: idOf(payload.assignee) };
  const nested = payload.conversation?.meta?.assignee ?? payload.meta?.assignee;
  if (nested !== undefined) return { present: true, id: idOf(nested) };
  for (const change of payload.changed_attributes || []) {
    if (change && Object.prototype.hasOwnProperty.call(change, 'assignee_id')) {
      return { present: true, id: idOf(change.assignee_id?.current_value) };
    }
  }
  return { present: false, id: null };
}

class Takeover {
  constructor(enabled = true) {
    this.enabled = enabled;
    this.assigned = new Set();
  }

  apply(conversationId, assigneeId) {
    if (!this.enabled) return false;
    const id = String(conversationId);
    if (assigneeId) {
      if (this.assigned.has(id)) return false;
      this.assigned.add(id);
      return true;
    }
    if (!this.assigned.has(id)) return false;
    this.assigned.delete(id);
    return true;
  }

  clear(conversationId) {
    this.assigned.delete(String(conversationId));
  }

  isAssigned(conversationId) {
    return this.assigned.has(String(conversationId));
  }
}

module.exports = { extractAssignee, Takeover };
