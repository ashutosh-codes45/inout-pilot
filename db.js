import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export async function logEvent(event, detail = '') {
  const { error } = await supabase.from('audit_log').insert({ event, detail });
  if (error) console.error('audit_log error:', error.message);
}

export async function saveInvoice(inv) {
  const { error } = await supabase.from('invoices').insert(inv);
  if (error) throw new Error(`saveInvoice failed: ${error.message}`);
  await logEvent('invoice_sent', `${inv.paypal_invoice_id} to ${inv.client_email}`);
}