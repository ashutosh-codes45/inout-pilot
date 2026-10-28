import { supabase, logEvent } from './db.js';
import { createPayout, getPayoutBatch } from './paypal.js';
import { findSupplier, evaluatePayout, precheck } from './policy.js';

const FAIL_ITEM_STATES = ['FAILED', 'RETURNED', 'BLOCKED', 'REVERSED', 'REFUNDED', 'DENIED'];

const statusFor = (d) => (d === 'BLOCK' ? 'BLOCKED' : d === 'ASK' ? 'PENDING_APPROVAL' : 'PROCESSING');
const escapeLike = (s) => String(s).trim().replace(/[%_\\]/g, '\\$&');

/** Resolve "pay after X pays": a PayPal invoice id, or a client name with exactly one unpaid invoice. */
async function findLinkedInvoice(ref) {
  const r = String(ref).trim();
  if (/^INV2-/i.test(r)) {
    const { data, error } = await supabase.from('invoices').select('*').eq('paypal_invoice_id', r).limit(1);
    if (error) throw error;
    if (!data.length) throw new Error(`No invoice found with id ${r}`);
    return data[0];
  }
  const { data, error } = await supabase.from('invoices').select('*')
    .ilike('client_name', escapeLike(r)).in('status', ['SENT', 'OVERDUE'])
    .order('created_at', { ascending: false });
  if (error) throw error;
  if (!data.length) throw new Error(`No unpaid invoice found for "${r}". Create the invoice first, or pay without linking.`);
  if (data.length > 1) {
    const list = data.map((i) => `${i.paypal_invoice_id} ($${i.amount}, due ${i.due_date})`).join('; ');
    throw new Error(`"${r}" has ${data.length} unpaid invoices: ${list}. Say which invoice id to wait for.`);
  }
  return data[0];
}

export async function requestPayout({ supplierName, amount, note = '', afterPaid = null, supplierDueDate = null }) {
  amount = Number(amount);
  const supplier = await findSupplier(supplierName);
  const linked = afterPaid ? await findLinkedInvoice(afterPaid) : null;
  const waiting = linked && linked.status !== 'PAID';

  let decision, reason, status;
  if (waiting) {
    const pre = precheck({ supplier, amount });   // fail fast on rules that can't change later
    if (pre) ({ decision, reason } = pre), (status = 'BLOCKED');
    else {
      decision = 'WAIT';
      status = 'WAITING_FOR_CLIENT';
      reason = `Waiting for ${linked.client_name} to pay invoice ${linked.paypal_invoice_id}`;
    }
  } else {
    ({ decision, reason } = await evaluatePayout({ supplier, amount }));
    status = statusFor(decision);
  }

  const { data: payment, error } = await supabase.from('payments').insert({
    supplier_name: supplier?.name ?? String(supplierName),
    supplier_email: supplier?.email ?? null,
    amount: Number.isFinite(amount) ? amount : 0,
    note, decision, reason, status,
    linked_invoice_id: linked?.id ?? null,
    due_date: supplierDueDate,
    decided_at: decision === 'ASK' || decision === 'WAIT' ? null : new Date().toISOString(),
  }).select().single();
  if (error) throw new Error(`requestPayout insert failed: ${error.message}`);

  await logEvent(`payout_${decision.toLowerCase()}`, `${payment.id} $${amount} to ${payment.supplier_name}: ${reason}`);

  if (decision === 'AUTO') await sendPayout(payment);
  return { id: payment.id, decision, reason, status };
}

/** Called when a client invoice becomes PAID. Safe to call twice: the conditional update claims each payout once. */
export async function releaseWaitingForInvoice(invoiceId) {
  const { data: waiting, error } = await supabase.from('payments')
    .select('*').eq('linked_invoice_id', invoiceId).eq('status', 'WAITING_FOR_CLIENT');
  if (error) throw error;
  const released = [];
  for (const p of waiting) {
    const supplier = await findSupplier(p.supplier_name);
    const { decision, reason } = await evaluatePayout({ supplier, amount: Number(p.amount) });
    const { data, error: e2 } = await supabase.from('payments').update({
      decision, reason: `Client paid. ${reason}`, status: statusFor(decision),
      decided_at: decision === 'ASK' ? null : new Date().toISOString(),
    }).eq('id', p.id).eq('status', 'WAITING_FOR_CLIENT').select();
    if (e2) throw e2;
    if (!data.length) continue;               // another run already released it
    await logEvent('payout_released', `${p.id}: client paid, policy says ${decision}`);
    if (decision === 'AUTO') await sendPayout(data[0]);
    released.push({ id: p.id, decision });
  }
  return released;
}

export async function cancelWaiting(id) {
  const { data, error } = await supabase.from('payments')
    .update({ status: 'CANCELLED', decided_at: new Date().toISOString() })
    .eq('id', id).eq('status', 'WAITING_FOR_CLIENT').select();
  if (error) throw error;
  if (!data.length) throw new Error('Payment not found or not waiting for a client');
  await logEvent('payout_cancelled', id);
  return { id, status: 'CANCELLED' };
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