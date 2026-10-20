import 'dotenv/config';
import express from 'express';
import { supabase, logEvent } from './db.js';
import { verifyWebhook } from './paypal.js';
import { runScheduler, startScheduler } from './scheduler.js';

const app = express();
app.use(express.json());

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
      // Payload shape may differ slightly; this checks both common locations
      const invoiceId = event.resource?.invoice?.id ?? event.resource?.id;
      console.log('Paid invoice id:', invoiceId);

      const { data, error } = await supabase
        .from('invoices')
        .update({ status: 'PAID', paid_at: new Date().toISOString() })
        .eq('paypal_invoice_id', invoiceId)
        .neq('status', 'PAID')
        .select();
      if (error) throw error;
      if (data.length) await logEvent('paid', invoiceId);
    }
    res.sendStatus(200);
  } catch (e) {
    console.error('Webhook error:', e);
    res.sendStatus(500);
  }
});

app.get('/admin/run-scheduler', async (req, res) => {
  res.json(await runScheduler());
});
startScheduler();

app.listen(3000, () => console.log('Server running on http://localhost:3000'));
app.get('/', (req, res) => res.send('InOut Pilot is running'));