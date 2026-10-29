import 'dotenv/config';
import { supabase, logEvent } from './db.js';

const BASE_URL = process.env.LLM_BASE_URL ?? 'https://api.groq.com/openai/v1';
const MODEL = process.env.LLM_MODEL ?? 'openai/gpt-oss-120b';

const plural = (n) => `${n} day${n === 1 ? '' : 's'}`;

async function draftExtension(p, daysLeft) {
  const when = daysLeft < 0 ? `${plural(-daysLeft)} ago` : `on ${p.due_date}`;
  const fallback =
    `Hi ${p.supplier_name}, a customer payment we were counting on is delayed. ` +
    `Could we move our $${p.amount} payment (due ${when}) back by a few days? Thank you for your patience.`;
  if (!process.env.LLM_API_KEY) return fallback;
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.LLM_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL, temperature: 0.4, max_tokens: 1500,
        messages: [
          { role: 'system', content:
            'Write a short, polite, honest message from a small merchant asking a supplier for a brief payment extension. ' +
            'Never name any customer and never say who is late; say only that an incoming payment is delayed. ' +
            'No promises of a specific date. Under 80 words. Output the message only.' },
          { role: 'user', content: `Supplier: ${p.supplier_name}. Amount: $${p.amount}. Original due date: ${p.due_date}.` },
        ],
      }),
    });
    if (!res.ok) return fallback;
    const choice = (await res.json()).choices?.[0];
    const text = choice?.finish_reason === 'length' ? '' : choice?.message?.content?.trim();
    return text || fallback;
  } catch {
    return fallback;
  }
}

/** Case 1 (due later): keep waiting. Case 2 (due soon, client unpaid): raise one alert.
 *  Case 3 (client paid) is handled by releaseWaitingForInvoice in payments.js. */
export async function runAlerts() {
  const windowDays = Number(process.env.ALERT_DAYS ?? 3);
  const today = new Date(new Date().toISOString().slice(0, 10));
  const { data, error } = await supabase.from('payments').select('*')
    .eq('status', 'WAITING_FOR_CLIENT').not('due_date', 'is', null).is('alerted_at', null);
  if (error) throw error;

  const out = [];
  for (const p of data) {
    const daysLeft = Math.round((new Date(p.due_date) - today) / 86400000);
    if (daysLeft > windowDays) continue;

    const { data: inv } = await supabase.from('invoices').select('*').eq('id', p.linked_invoice_id).maybeSingle();
    const timing = daysLeft < 0 ? `${plural(-daysLeft)} overdue` : daysLeft === 0 ? 'due today' : `due in ${plural(daysLeft)}`;
    const alert =
      `${p.supplier_name} ($${p.amount}) is ${timing}, but ${inv?.client_name ?? 'the client'} ` +
      `has not paid invoice ${inv?.paypal_invoice_id ?? ''}. Options: pay now, pay part, or ask for an extension.`;
    const draft = await draftExtension(p, daysLeft);

    const { data: upd, error: e2 } = await supabase.from('payments')
      .update({ alerted_at: new Date().toISOString(), alert_text: alert, extension_draft: draft })
      .eq('id', p.id).is('alerted_at', null).select();
    if (e2) throw e2;
    if (upd.length) {
      await logEvent('payout_alert', `${p.id}: ${alert}`);
      out.push(`${p.id}: alert raised`);
    }
  }
  return out;
}