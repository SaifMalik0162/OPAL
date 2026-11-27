export function selectTrackRange(order, selected, anchor, id, { range = false, toggle = false } = {}) {
  if (range && order.includes(anchor)) {
    const a = order.indexOf(anchor), b = order.indexOf(id);
    const ids = order.slice(Math.min(a, b), Math.max(a, b) + 1);
    return new Set(toggle ? [...selected, ...ids] : ids);
  }
  if (toggle) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  }
  return new Set([id]);
}

export function insertTrackSelection(order, selected, target, after = false) {
  if (selected.has(target)) return order;
  const moving = order.filter(id => selected.has(id));
  const rest = order.filter(id => !selected.has(id));
  const at = rest.indexOf(target);
  if (at < 0) return order;
  rest.splice(at + Number(after), 0, ...moving);
  return rest;
}
