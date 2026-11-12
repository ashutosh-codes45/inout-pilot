import { supabase } from './db.js';

const DAY = 86400000;
const day = (d) => new Date(String(d).slice(0, 10));
export const keyOf = (name) => String(name ?? '').trim().toLowerCase();

/** Rule-based and explainable: no AI decides the score. */
export function scoreClient(invs, today = new Date().toISOString().slice(0, 10)) {
  const paid = invs.filter((i) => i.status === 'PAID' && i.paid_at);
  const open = invs.filter((i) => i.status !== 'PAID');
  const lateDays = paid.map((i) => Math.max(0, Math.round((day(i.paid_at) - day(i.due_date)) / DAY)));
  const lateCount = lateDays.filter((d) => d > 0).length;
  const avgLate = paid.length ? lateDays.reduce((a, b) => a + b, 0) / paid.length : 0;
  const overdueOpen = open.filter((i) => i.due_date < today).length;
  const avgReminders = invs.length ? invs.reduce((s, i) => s + (i.reminders_sent ?? 0), 0) / invs.length : 0;
  const onTimeRate = paid.length ? (paid.length - lateCount) / paid.length : null;

  let score = 100;
  if (onTimeRate !== null) score -= (1 - onTimeRate) * 40;
  score -= Math.min(25, avgLate * 2);
  score -= Math.min(30, overdueOpen * 15);
  score -= Math.min(15, avgReminders * 5);
  score = Math.max(0, Math.round(score));

    const enough = paid.length >= 3;
  let tier = score < 50 ? 'Risky' : !enough ? 'New' : score >= 80 ? 'Reliable' : 'Watch';
  if (overdueOpen > 0 && (tier === 'Reliable' || tier === 'New')) tier = 'Watch'; // an overdue invoice is never "Reliable" or "New"



  const bits = [];
  if (paid.length) bits.push(`${lateCount} of ${paid.length} paid invoices were late` + (lateCount ? ` (avg ${avgLate.toFixed(1)} days late)` : ''));
  if (overdueOpen) bits.push(`${overdueOpen} open invoice(s) overdue`);
  if (avgReminders >= 0.5) bits.push(`needs ${avgReminders.toFixed(1)} reminders per invoice`);
  if (!paid.length && !overdueOpen) bits.push('no paid invoices yet');
  if (!enough) bits.push(`not enough history yet (${paid.length} of 3 paid invoices)`);

  return {
    score, tier, invoices: invs.length, paid: paid.length,
    onTimeRate, avgDaysLate: Number(avgLate.toFixed(1)), overdueOpen,
    avgReminders: Number(avgReminders.toFixed(1)), reason: bits.join('; '),
  };
}

export async function computeScores() {
  const { data, error } = await supabase.from('invoices').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  const groups = new Map();
  for (const i of data) {
    const k = keyOf(i.client_name);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(i);
  }
  return [...groups.values()]
    .map((invs) => ({ client_name: invs[0].client_name, client_email: invs[0].client_email, ...scoreClient(invs) }))
    .sort((a, b) => a.score - b.score);
}

export async function tierMap() {
  return new Map((await computeScores()).map((s) => [keyOf(s.client_name), s.tier]));
}