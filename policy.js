import 'dotenv/config';
import { supabase } from './db.js';

// Plain code, not AI: every limit lives here and in .env.
export const LIMITS = {
  auto: Number(process.env.PAYOUT_AUTO_LIMIT ?? 100),    // <= this and trusted supplier -> pay automatically
  hard: Number(process.env.PAYOUT_HARD_LIMIT ?? 1000),   // > this -> blocked outright
  daily: Number(process.env.PAYOUT_DAILY_CAP ?? 2000),   // total paid/in-flight per UTC day
};

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
  if (!supplier) return { decision: 'BLOCK', reason: 'Supplier is not on the approved list' };
  if (!Number.isFinite(amount) || amount <= 0) return { decision: 'BLOCK', reason: 'Invalid amount' };
  if (amount > LIMITS.hard) return { decision: 'BLOCK', reason: `Amount exceeds hard limit of $${LIMITS.hard}` };

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