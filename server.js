import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import { supabase, logEvent } from './db.js';
import { verifyWebhook } from './paypal.js';
import { runScheduler, startScheduler } from './scheduler.js';
import { handleMerchantRequest } from './agent.js';
import { approvePayout, rejectPayout, reconcileBatch } from './payments.js';

const app = express();
app.use(express.json());
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

// ---------- Dashboard data ----------
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));