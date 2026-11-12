import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import { supabase, logEvent } from './db.js';
import { verifyWebhook } from './paypal.js';
import { runScheduler, startScheduler } from './scheduler.js';
import { handleMerchantRequest } from './agent.js';
import {
  approvePayout, rejectPayout, reconcileBatch,
  releaseWaitingForInvoice, cancelWaiting, payNow,
} from './payments.js';
import { computeScores } from './scores.js';
import { computeShift } from './shift.js';
import { draftExtension } from './alerts.js';

const app = express();
app.use(express.json());
app.use('/vendor/ag-grid', express.static('node_modules/ag-grid-community'));
// Bryntum views (trial packages), mounted read-only from node_modules.
app.use('/vendor/bryntum/schedulerpro', express.static('node_modules/@bryntum/schedulerpro'));
app.use('/vendor/bryntum/gantt', express.static('node_modules/@bryntum/gantt'));
app.use('/vendor/bryntum/calendar', express.static('node_modules/@bryntum/calendar'));
app.use('/vendor/bryntum/taskboard', express.static('node_modules/@bryntum/taskboard'));
app.use(express.static('public')); // dashboard (data endpoints below need the key)

// ---------- auth for everything except the PayPal webhook ----------
function requireAdmin(req, res, next) {
  const key = process.env.ADMIN_API_KEY;
  const given = req.get('x-api-key') ?? '';
  const ok = key && given.length === key.length &&
    crypto.timingSafeEqual(Buffer.from(given), Buffer.from(key));
  if (!ok) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ---------- PayPal webhook ----------
app.post('/webhooks/paypal', async (req, res) => {
  try {
    const ok = await verifyWebhook(req.headers, req.body);
    if (!ok) {
      console.warn('Webhook signature check failed');
      return res.sendStatus(400);
    }
    const event = req.body;
    console.log('Webhook received:', event.event_type);

    if (event.event_type === 'INVOICING.INVOICE.PAID') {
      const invoiceId = event.resource?.invoice?.id ?? event.resource?.id;
      const { data, error } = await supabase
        .from('invoices')
        .update({ status: 'PAID', paid_at: new Date().toISOString() })
        .eq('paypal_invoice_id', invoiceId)
        .neq('status', 'PAID')
        .select();
      if (error) throw error;
      if (data.length) await logEvent('paid', invoiceId);

      // Release linked payouts. Runs even on a repeat webhook, so a failed attempt can be retried.
      const { data: inv } = await supabase.from('invoices').select('id').eq('paypal_invoice_id', invoiceId).maybeSingle();
      if (inv) await releaseWaitingForInvoice(inv.id);
    }

    // Payout events: don't trust payload shape for status, just re-read the batch from PayPal.
    if (event.event_type?.startsWith('PAYMENT.PAYOUTS')) {
      const batchId = event.resource?.batch_header?.payout_batch_id ?? event.resource?.payout_batch_id;
      if (batchId) await reconcileBatch(batchId);
    }
    res.sendStatus(200);
  } catch (e) {
    console.error('Webhook error:', e);
    res.sendStatus(500);
  }
});

// ---------- Agent entry point: "Merchant request" in the flow ----------
app.post('/agent/request', requireAdmin, async (req, res) => {
  try {
    res.json(await handleMerchantRequest(req.body?.message));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- "Ask first": merchant OKs or rejects ----------
app.post('/payments/:id/approve', requireAdmin, async (req, res) => {
  try { res.json(await approvePayout(req.params.id)); }
  catch (e) { res.status(409).json({ error: e.message }); }
});
app.post('/payments/:id/reject', requireAdmin, async (req, res) => {
  try { res.json(await rejectPayout(req.params.id)); }
  catch (e) { res.status(409).json({ error: e.message }); }
});

// ---------- Pay-when-paid: cancel, or pay early after an alert ----------
app.post('/payments/:id/cancel', requireAdmin, async (req, res) => {
  try { res.json(await cancelWaiting(req.params.id)); }
  catch (e) { res.status(409).json({ error: e.message }); }
});
app.post('/payments/:id/pay-now', requireAdmin, async (req, res) => {
  try { res.json(await payNow(req.params.id, req.body?.amount ?? null)); }
  catch (e) { res.status(409).json({ error: e.message }); }
});
app.post('/payments/:id/extension', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('payments')
      .select('id, supplier_name, amount, due_date, extension_draft')
      .eq('id', req.params.id).eq('status', 'WAITING_FOR_CLIENT').maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('No waiting payout for this payment');

    let draft = data.extension_draft;
    if (!draft) {
      const today = new Date(new Date().toISOString().slice(0, 10));
      const daysLeft = data.due_date ? Math.round((new Date(data.due_date) - today) / 86400000) : 0;
      draft = await draftExtension(data, daysLeft);
      const { error: e2 } = await supabase.from('payments').update({ extension_draft: draft }).eq('id', data.id);
      if (e2) throw e2;
    }
    await logEvent('extension_requested', req.params.id);
    res.json({ ...data, extension_draft: draft });
  } catch (e) { res.status(409).json({ error: e.message }); }
});

// ---------- Timeline: move an invoice's expected pay date (and the payouts waiting on it) ----------
app.post('/api/invoices/:id/shift', requireAdmin, async (req, res) => {
  try {
    const { data: invoice, error: e1 } = await supabase.from('invoices')
      .select('*').eq('id', req.params.id).maybeSingle();
    if (e1) throw e1;
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    const { data: payouts, error: e2 } = await supabase.from('payments')
      .select('id, status, planned_date, due_date').eq('linked_invoice_id', invoice.id);
    if (e2) throw e2;

    let plan;
    try {
      plan = computeShift(invoice, payouts ?? [], req.body?.expected_pay_date);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    const { error: e3 } = await supabase.from('invoices')
      .update({ expected_pay_date: plan.invoice.expected_pay_date }).eq('id', invoice.id);
    if (e3) throw e3;

    for (const p of plan.payouts) {
      const { error: e4 } = await supabase.from('payments')
        .update({ planned_date: p.planned_date }).eq('id', p.id);
      if (e4) throw e4;
    }

    // The PayPal invoice and the client are untouched on purpose.
    await logEvent('expected_pay_shifted',
      `${invoice.id}: ${invoice.expected_pay_date ?? invoice.due_date} -> ${plan.invoice.expected_pay_date} (${plan.days} days)`);

    res.json({
      invoice: { ...invoice, expected_pay_date: plan.invoice.expected_pay_date },
      payouts: plan.payouts,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Dashboard data ----------
app.get('/api/alerts', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('payments').select('*')
      .eq('status', 'WAITING_FOR_CLIENT').not('alerted_at', 'is', null).order('alerted_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/overview', requireAdmin, async (req, res) => {
  try {
    const [inv, pay, audit] = await Promise.all([
      supabase.from('invoices').select('*').order('created_at', { ascending: false }).limit(500),
      supabase.from('payments').select('*').order('created_at', { ascending: false }).limit(500),
      supabase.from('audit_log').select('*').order('created_at', { ascending: false }).limit(500),
    ]);
    for (const r of [inv, pay, audit]) if (r.error) throw r.error;
    res.json({ invoices: inv.data, payments: pay.data, audit: audit.data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/admin/run-scheduler', requireAdmin, async (req, res) => {
  res.json(await runScheduler());
});

app.get('/health', (req, res) => res.send('InOut Pilot is running'));

startScheduler();

app.get('/api/scores', requireAdmin, async (req, res) => {
  try { res.json(await computeScores()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));