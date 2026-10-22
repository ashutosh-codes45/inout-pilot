import { supabase, logEvent } from './db.js';
import { createPayout, getPayoutBatch } from './paypal.js';
import { findSupplier, evaluatePayout } from './policy.js';

const FAIL_ITEM_STATES = ['FAILED', 'RETURNED', 'BLOCKED', 'REVERSED', 'REFUNDED', 'DENIED'];

export async function requestPayout({ supplierName, amount, note = '' }) {
  amount = Number(amount);
  const supplier = await findSupplier(supplierName);
  const { decision, reason } = await evaluatePayout({ supplier, amount });

  const status = decision === 'BLOCK' ? 'BLOCKED' : decision === 'ASK' ? 'PENDING_APPROVAL' : 'PROCESSING';
  const { data: payment, error } = await supabase.from('payments').insert({
    supplier_name: supplier?.name ?? String(supplierName),
    supplier_email: supplier?.email ?? null,
    amount: Number.isFinite(amount) ? amount : 0,
    note, decision, reason, status,
    decided_at: decision === 'ASK' ? null : new Date().toISOString(),
  }).select().single();
  if (error) throw new Error(`requestPayout insert failed: ${error.message}`);

  await logEvent(`payout_${decision.toLowerCase()}`, `${payment.id} $${amount} to ${payment.supplier_name}: ${reason}`);

  if (decision === 'AUTO') await sendPayout(payment);
  return { id: payment.id, decision, reason, status: decision === 'AUTO' ? 'PROCESSING' : status };
}

/** Merchant clicked OK. The conditional update means a double-click can't pay twice. */
export async function approvePayout(id) {
  const { data, error } = await supabase.from('payments')
    .update({ status: 'PROCESSING', decided_at: new Date().toISOString() })
    .eq('id', id).eq('status', 'PENDING_APPROVAL').select();
  if (error) throw error;
  if (!data.length) throw new Error('Payment not found or not awaiting approval');
  await logEvent('payout_approved', id);
  await sendPayout(data[0]);
  return { id, status: 'PROCESSING' };
}

export async function rejectPayout(id) {
  const { data, error } = await supabase.from('payments')
    .update({ status: 'REJECTED', decided_at: new Date().toISOString() })
    .eq('id', id).eq('status', 'PENDING_APPROVAL').select();
  if (error) throw error;
  if (!data.length) throw new Error('Payment not found or not awaiting approval');
  await logEvent('payout_rejected', id);
  return { id, status: 'REJECTED' };
}

async function sendPayout(p) {
  try {
    const res = await createPayout({
      id: p.id, email: p.supplier_email, amount: p.amount, currency: p.currency, note: p.note,
    });
    const batchId = res.batch_header?.payout_batch_id;
    await supabase.from('payments').update({ paypal_batch_id: batchId }).eq('id', p.id);
    await logEvent('payout_sent', `${p.id} batch ${batchId}`);
  } catch (e) {
    await supabase.from('payments').update({ status: 'FAILED', error: e.message.slice(0, 500) }).eq('id', p.id);
    await logEvent('payout_failed', `${p.id}: ${e.message.slice(0, 200)}`);
  }
}

/** Pull PayPal's real status for one batch (called by webhook and by the scheduler). */
export async function reconcileBatch(batchId) {
  const batch = await getPayoutBatch(batchId);
  const item = batch.items?.[0];
  const itemStatus = item?.transaction_status;
  const batchStatus = batch.batch_header?.batch_status;

  let next = null;
  if (itemStatus === 'SUCCESS') next = 'SUCCESS';
  else if (FAIL_ITEM_STATES.includes(itemStatus) || ['DENIED', 'CANCELED'].includes(batchStatus)) next = 'FAILED';
  if (!next) return null; // still PENDING / UNCLAIMED / ONHOLD

  const { data, error } = await supabase.from('payments')
    .update({ status: next, error: next === 'FAILED' ? `PayPal: ${itemStatus ?? batchStatus}` : null })
    .eq('paypal_batch_id', batchId).eq('status', 'PROCESSING').select();
  if (error) throw error;
  if (data.length) await logEvent(next === 'SUCCESS' ? 'payout_success' : 'payout_failed', `${data[0].id} (${itemStatus ?? batchStatus})`);
  return next;
}

export async function reconcilePayouts() {
  const { data, error } = await supabase.from('payments')
    .select('paypal_batch_id').eq('status', 'PROCESSING').not('paypal_batch_id', 'is', null);
  if (error) throw error;
  const out = [];
  for (const { paypal_batch_id } of data) {
    try {
      const r = await reconcileBatch(paypal_batch_id);
      if (r) out.push(`${paypal_batch_id}: ${r}`);
    } catch (e) {
      console.error('reconcile error', paypal_batch_id, e.message);
    }
  }
  return out;
}