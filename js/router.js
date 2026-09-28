// Tiny hash router: #/path/segments?query

const leaveHooks = [];
let skipNextLeave = false;

export function parse(hash = location.hash) {
  const raw = hash.replace(/^#\/?/, '');
  const [path, qs = ''] = raw.split('?');
  return { parts: path.split('/').filter(Boolean), params: new URLSearchParams(qs), path };
}

export function navigate(hash, { skipLeave = false } = {}) {
  if (skipLeave) skipNextLeave = true;
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = hash;
}

export function onLeave(fn) { leaveHooks.push(fn); }

export async function runLeave(prev) {
  if (skipNextLeave) { skipNextLeave = false; return; }
  for (const fn of leaveHooks) await fn(prev);
}
