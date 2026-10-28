import 'dotenv/config';
import { supabase } from './db.js';

// Plain code, not AI: every limit lives here and in .env.
export const LIMITS = {
  auto: Number(process.env.PAYOUT_AUTO_LIMIT ?? 100),    // <= this and trusted supplier -> pay automatically
  hard: Number(process.env.PAYOUT_HARD_LIMIT ?? 1000),   // > this -> blocked outright
  daily: Number(process.env.PAYOUT_DAILY_CAP ?? 2000),   // total paid/in-flight per UTC day
};

/** Static rules that don't depend on timing. Returns a BLOCK result or null. */
export function precheck({ supplier, amount }) {
  if (!supplier) return { decision: 'BLOCK', reason: 'Supplier is not on the approved list' };
  if (!Number.isFinite(amount) || amount <= 0) return { decision: 'BLOCK', reason: 'Invalid amount' };
  if (amount > LIMITS.hard) return { decision: 'BLOCK', reason: `Amount exceeds hard limit of $${LIMITS.hard}` };
  return null;
}

export async function findSupplier(name) {
  const safe = String(name ?? '').trim().replace(/[%_\\]/g, '\\$&');
  if (!safe) return null;
  const { data, error } = await supabase
    .from('suppliers').select('*').eq('active', true).ilike('name', safe).limit(1);
  if (error) throw error;
  return data[0] ?? null;
}

async function paidTodayTotal() {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const { data, error } = await supabase
    .from('payments').select('amount')
    .in('status', ['PROCESSING', 'SUCCESS'])
    .gte('created_at', start.toISOString());
  if (error) throw error;
  return data.reduce((s, p) => s + Number(p.amount), 0);
}

async function hasPaidBefore(supplierEmail) {
  const { count, error } = await supabase
    .from('payments').select('id', { count: 'exact', head: true })
    .eq('supplier_email', supplierEmail).eq('status', 'SUCCESS');
  if (error) throw error;
  return count > 0;
}

/** @returns {{decision:'AUTO'|'ASK'|'BLOCK', reason:string}} */
export async function evaluatePayout({ supplier, amount }) {
  const pre = precheck({ supplier, amount });
  if (pre) return pre;

  const today = await paidTodayTotal();
  if (today + amount > LIMITS.daily)
    return { decision: 'BLOCK', reason: `Would exceed daily cap of $${LIMITS.daily} (already $${today.toFixed(2)})` };

  // Trusted = merchant pre-approved this supplier in the suppliers table, or we've paid them before.
  if (!supplier.trusted && !(await hasPaidBefore(supplier.email)))
    return { decision: 'ASK', reason: 'First payment to an untrusted supplier needs merchant approval' };

  if (amount <= LIMITS.auto)
    return { decision: 'AUTO', reason: `Under auto-pay limit of $${LIMITS.auto}` };

  return { decision: 'ASK', reason: `Over auto-pay limit of $${LIMITS.auto}; merchant must approve` };
}

export const CONFIG = { AUTO_LIMIT: 100, HARD_LIMIT: 1000, DAILY_CAP: 1500 };

export function decide({ amount, partner, paidToday }, cfg = CONFIG) {
  if (!Number.isFinite(amount) || amount <= 0)
    return { decision: 'BLOCK', reason: 'Invalid amount' };
  if (amount > cfg.HARD_LIMIT)
    return { decision: 'BLOCK', reason: `Above the hard limit of $${cfg.HARD_LIMIT}` };
  if (partner?.blocked)
    return { decision: 'BLOCK', reason: 'Recipient is on the blocked list' };
  if (paidToday + amount > cfg.DAILY_CAP)
    return { decision: 'BLOCK', reason: `Would exceed the daily cap of $${cfg.DAILY_CAP}` };
  if (!partner)
    return { decision: 'ASK', reason: 'New recipient needs your approval' };
  const limit = Number(partner.auto_limit ?? cfg.AUTO_LIMIT);
  if (amount > limit)
    return { decision: 'ASK', reason: `Above ${partner.name}'s auto-pay limit of $${limit}` };
  return { decision: 'AUTO', reason: `Known partner, within the $${limit} auto-pay limit` };
}