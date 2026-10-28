import { supabase, logEvent } from './db.js';
import { decide } from './policy.js';
import { sendPayout } from './paypal.js';

async function paidToday() {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const { data, error } = await supabase.from('payouts')
    .select('amount').eq('status', 'SENT').gte('created_at', start.toISOString());
  if (error) throw error;
  return data.reduce((sum, r) => sum + Number(r.amount), 0);
}

async function execute(row) {
  try {
    const res = await sendPayout({
      email: row.recipient_email, amount: Number(row.amount),
      currency: row.currency, note: row.note, senderItemId: row.id,
    });
    const { data } = await supabase.from('payouts').update({
      status: 'SENT',
      paypal_batch_id: res.batch_header?.payout_batch_id,
      decided_at: new Date().toISOString(),
    }).eq('id', row.id).select().single();
    await logEvent('payout_sent', `${row.id}: $${row.amount} to ${row.recipient_email}`);
    return data;
  } catch (e) {
    await supabase.from('payouts').update({ status: 'FAILED' }).eq('id', row.id);
    await logEvent('payout_failed', `${row.id}: ${e.message.slice(0, 300)}`);
    throw e;
  }
}

export async function requestPayout({ email, name, amount, note }) {
  email = String(email).trim().toLowerCase();
  amount = Number(amount);
  const { data: partner } = await supabase.from('partners')
    .select('*').eq('email', email).maybeSingle();
  const { decision, reason } = decide({ amount, partner, paidToday: await paidToday() });
  const status = { AUTO: 'PROCESSING', ASK: 'PENDING_APPROVAL', BLOCK: 'BLOCKED' }[decision];

  const { data: row, error } = await supabase.from('payouts').insert({
    recipient_email: email,
    recipient_name: name ?? partner?.name ?? null,
    amount: Number.isFinite(amount) ? amount : 0,
    note, decision, reason, status,
  }).select().single();
  if (error) throw error;

  await logEvent(`payout_${decision.toLowerCase()}`, `${row.id}: ${reason}`);
  return decision === 'AUTO' ? execute(row) : row;
}

export async function approvePayout(id, remember = false) {
  // claim it first so a double click can't pay twice
  const { data: claimed, error } = await supabase.from('payouts')
    .update({ status: 'PROCESSING' }).eq('id', id).eq('status', 'PENDING_APPROVAL').select();
  if (error) throw error;
  if (!claimed.length) throw new Error('Payout not found or not pending approval');
  const row = claimed[0];

  // you can override ASK, but never the hard limit or daily cap
  const check = decide({
    amount: Number(row.amount),
    partner: { name: 'approved', auto_limit: Infinity, blocked: false },
    paidToday: await paidToday(),
  });
  if (check.decision === 'BLOCK') {
    const { data } = await supabase.from('payouts').update({
      status: 'BLOCKED', reason: check.reason, decided_at: new Date().toISOString(),
    }).eq('id', id).select().single();
    await logEvent('payout_blocked', `${id}: ${check.reason} (at approval)`);
    return data;
  }
  if (remember) {
    await supabase.from('partners').upsert(
      { name: row.recipient_name ?? row.recipient_email, email: row.recipient_email },
      { onConflict: 'email', ignoreDuplicates: true }
    );
  }
  await logEvent('payout_approved', id);
  return execute(row);
}

export async function rejectPayout(id) {
  const { data, error } = await supabase.from('payouts')
    .update({ status: 'REJECTED', decided_at: new Date().toISOString() })
    .eq('id', id).eq('status', 'PENDING_APPROVAL').select();
  if (error) throw error;
  if (!data.length) throw new Error('Payout not found or not pending approval');
  await logEvent('payout_rejected', id);
  return data[0];
}