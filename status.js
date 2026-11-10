import { supabase } from './db.js';
import { computeScores } from './scores.js';

const key = (s) => String(s ?? '').trim().toLowerCase();
const money = (n) => `$${Number(n).toFixed(2)}`;
const uniq = (a) => [...new Set(a)];

/** Pure function: all numbers come from code, never from the model. */
export function buildStatus({ invoices, payments, scores, today = new Date().toISOString().slice(0, 10) }) {
  const tier = new Map(scores.map((s) => [key(s.client_name), s.tier]));
  const days = (d) => Math.round((new Date(d) - new Date(today)) / 86400000);
  const byId = new Map(invoices.map((i) => [i.id, i]));
  const sum = (rows) => rows.reduce((s, r) => s + r.amount, 0);

  const receivables = invoices.map((i) => ({
    client: i.client_name, amount: Number(i.amount), invoice: i.paypal_invoice_id, due_date: i.due_date,
    overdue: i.due_date < today, days_overdue: Math.max(0, -days(i.due_date)),
    tier: tier.get(key(i.client_name)) ?? 'New',
  }));
  const waiting = payments.filter((p) => p.status === 'WAITING_FOR_CLIENT').map((p) => {
    const inv = byId.get(p.linked_invoice_id);
    return {
      id: p.id, supplier: p.supplier_name, amount: Number(p.amount),
      waiting_on: inv?.client_name ?? 'a client', client_due_date: inv?.due_date ?? null,
      supplier_due_date: p.due_date, alerted: Boolean(p.alerted_at),
      at_risk: Boolean(p.alerted_at || (p.due_date && inv?.due_date && p.due_date < inv.due_date)),
    };
  });
  const approvals = payments.filter((p) => p.status === 'PENDING_APPROVAL')
    .map((p) => ({ id: p.id, supplier: p.supplier_name, amount: Number(p.amount), reason: p.reason }));

  const overdue = receivables.filter((r) => r.overdue);
  const atRisk = waiting.filter((w) => w.at_risk);
  const risky = uniq(receivables.filter((r) => r.tier === 'Risky').map((r) => r.client));

  const recv = [];
  if (receivables.length) {
    recv.push(`You are owed ${money(sum(receivables))} across ${receivables.length} unpaid invoice${receivables.length === 1 ? '' : 's'}` +
      (overdue.length ? `, ${money(sum(overdue))} of it overdue (${uniq(overdue.map((o) => o.client)).join(', ')}).` : '.'));
  } else recv.push('No unpaid invoices.');
  if (risky.length) recv.push(`Risky payers: ${risky.join(', ')}.`);

  const pay = [];
  if (waiting.length) {
    pay.push(`${money(sum(waiting))} of supplier payouts are waiting for clients to pay` +
      (atRisk.length ? `; ${atRisk.length} at risk of being late (${atRisk.map((w) => `${w.supplier} ${money(w.amount)}`).join(', ')}).` : '.'));
  }
  if (approvals.length) {
    pay.push(`${approvals.length} payout${approvals.length === 1 ? ' needs' : 's need'} your approval (${money(sum(approvals))}).`);
  }
  if (!waiting.length && !approvals.length) pay.push('No supplier payments are waiting or need approval.');

  const all = !receivables.length && !waiting.length && !approvals.length
    ? 'Nothing needs your attention.' : [...recv, ...pay].join(' ');

  return {
    summary: all,
    summaries: { all, receivables: recv.join(' '), payables: pay.join(' ') },
    totals: { owed: sum(receivables), overdue: sum(overdue), waiting_payouts: sum(waiting), awaiting_approval: sum(approvals) },
    receivables, waiting_payouts: waiting, awaiting_approval: approvals,
  };
}

export async function getStatus(focus = 'all') {
  const [inv, pay, scores] = await Promise.all([
    supabase.from('invoices').select('*').in('status', ['SENT', 'OVERDUE']).order('due_date'),
    supabase.from('payments').select('*').in('status', ['WAITING_FOR_CLIENT', 'PENDING_APPROVAL']).order('created_at'),
    computeScores(),
  ]);
  if (inv.error) throw inv.error;
  if (pay.error) throw pay.error;
  const s = buildStatus({ invoices: inv.data, payments: pay.data, scores });
  if (focus === 'receivables') return { summary: s.summaries.receivables, totals: s.totals, receivables: s.receivables };
  if (focus === 'payables') return { summary: s.summaries.payables, totals: s.totals, waiting_payouts: s.waiting_payouts, awaiting_approval: s.awaiting_approval };
  return s;
}