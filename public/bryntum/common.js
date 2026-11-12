// Shared helpers for the Bryntum views: auth, data loading, colours by status, nav bar.
// Every DB value that reaches the DOM goes through esc() first.

export const getKey = () => sessionStorage.getItem('inout-key') || '';

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'x-api-key': getKey(), 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'HTTP ' + res.status);
  return body;
}

export const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) });

export async function loadAll() {
  const [overview, scores] = await Promise.all([api('/api/overview'), api('/api/scores')]);
  return { ...overview, scores };
}

export function requireKey() {
  if (getKey()) return true;
  say('No admin key. Open the dashboard, type your key and press Connect, then come back.', 'err');
  return false;
}

// ---------- text ----------
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const money = (n) => '$' + Number(n || 0).toFixed(2);
export const label = (status) => String(status ?? '').toLowerCase().replace(/_/g, ' ');

// ---------- dates (day granularity, local time) ----------
export function day(v) {
  if (!v) return null;
  const s = String(v);
  if (s.length === 10) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
  const t = new Date(s);
  return Number.isNaN(t.getTime()) ? null : new Date(t.getFullYear(), t.getMonth(), t.getDate());
}
export const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
export const daysBetween = (a, b) => Math.round((a - b) / 86400000);
export const iso = (d) => (d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : null);

// ---------- colours by status ----------
// Bryntum turns these names into its own b-sch-color-* classes.
export const COLORS = {
  SENT: 'violet', PAID: 'green', OVERDUE: 'red',
  WAITING_FOR_CLIENT: 'orange', PENDING_APPROVAL: 'orange', PROCESSING: 'violet',
  SUCCESS: 'green', FAILED: 'red', BLOCKED: 'red', REJECTED: 'red', CANCELLED: 'gray',
};
export const colorOf = (status) => COLORS[status] || 'gray';
export const HEX = { violet: '#534ab7', green: '#0f6e56', red: '#a32d2d', orange: '#f59e0b', gray: '#6b6a65' };

// ---------- cash-flow helpers ----------
/** The date the client is expected to pay: expected_pay_date, else due_date. */
export const invoiceExpected = (i) => (i ? day(i.expected_pay_date) || day(i.due_date) : null);

/** The date a supplier payout is planned to leave. Falls through planned_date, the linked invoice, due_date, then created_at, so an unlinked payout still has a day. */
export function plannedDate(p, invoiceById) {
  if (!p) return null;
  const linked = p.linked_invoice_id ? invoiceById?.get(String(p.linked_invoice_id)) : null;
  return day(p.planned_date) || invoiceExpected(linked) || day(p.due_date) || day(p.created_at);
}

/** True when a payout is planned to leave after the date the supplier was promised. */
export function isConflict(p, invoiceById) {
  const planned = plannedDate(p, invoiceById);
  const due = day(p?.due_date);
  return Boolean(planned && due && planned > due);
}

// ---------- page chrome ----------
export const PAGES = [
  { href: '/', label: 'Dashboard' },
  { href: '/timeline.html', label: 'Timeline' },
  { href: '/gantt.html', label: 'Gantt' },
  { href: '/calendar.html', label: 'Calendar' },
  { href: '/taskboard.html', label: 'Taskboard' },
];

export function mountNav(current, subtitle = '') {
  // Only static labels from PAGES go in here, never database values.
  document.querySelector('header nav').innerHTML = PAGES
    .map((p) => `<a class="navbtn${p.href === current ? ' on' : ''}" href="${p.href}">${p.label}</a>`)
    .join('');
  const small = document.querySelector('header h1 small');
  if (small && subtitle) small.textContent = subtitle;
}

export function say(text, cls = '') {
  const el = document.getElementById('msg');
  if (el) { el.textContent = text; el.className = 'msg ' + cls; }
}

// A message that survives the full page reload we do after every change.
export function flash(text, cls = '') { sessionStorage.setItem('inout-flash', JSON.stringify({ text, cls })); }
export function takeFlash() {
  const raw = sessionStorage.getItem('inout-flash');
  if (!raw) return null;
  sessionStorage.removeItem('inout-flash');
  try { return JSON.parse(raw); } catch { return null; }
}
