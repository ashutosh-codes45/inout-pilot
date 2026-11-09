import 'dotenv/config';
import cron from 'node-cron';
import { supabase, logEvent } from './db.js';
import { getInvoice, sendReminder } from './paypal.js';
import { reconcilePayouts } from './payments.js';
import { releaseWaitingForInvoice } from './payments.js';
import { runAlerts } from './alerts.js';
import { tierMap, keyOf } from './scores.js';
import { draftReminder } from './reminders.js';

const LEAD_DAYS = { Risky: 5, Watch: 3, Reliable: 1, New: 1 };

const MAX_REMINDERS = 3;
const GAP_DAYS = Number(process.env.REMINDER_GAP_DAYS ?? 2);
const PAID_STATES = ['PAID', 'MARKED_AS_PAID'];

function buildReminder(inv, level, overdue) {
  const tone = [
    { subject: `Friendly reminder: invoice for ${inv.description}`,
      note: `Hi ${inv.client_name}, just a quick reminder that your invoice of $${inv.amount} is ${overdue ? 'now past due' : 'due soon'}. Thank you!` },
    { subject: `Payment overdue: invoice for ${inv.description}`,
      note: `Hi ${inv.client_name}, your payment of $${inv.amount} is overdue. Please settle it at your earliest convenience.` },
    { subject: `Final notice: invoice for ${inv.description}`,
      note: `Hi ${inv.client_name}, this is a final reminder for the overdue $${inv.amount} invoice. Please pay today or contact us.` },
  ];
  return tone[Math.min(level, 2)];
}

export async function runScheduler() {
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const results = [];
  const tiers = await tierMap();

  const { data: invoices, error } = await supabase
    .from('invoices').select('*').in('status', ['SENT', 'OVERDUE']);
  if (error) throw error;

  for (const inv of invoices) {
    try {
      // 1. Check PayPal's live status in case a webhook was missed
      const live = await getInvoice(inv.paypal_invoice_id);
      if (PAID_STATES.includes(live.status)) {
        await supabase.from('invoices')
          .update({ status: 'PAID', paid_at: new Date().toISOString() })
          .eq('id', inv.id);
        await logEvent('paid', `${inv.paypal_invoice_id} (found by scheduler)`);
        await releaseWaitingForInvoice(inv.id);
        results.push(`${inv.paypal_invoice_id}: marked paid`);
        continue;
      }

      // 2. Mark overdue
      const overdue = inv.due_date < today;
      if (overdue && inv.status !== 'OVERDUE') {
        await supabase.from('invoices').update({ status: 'OVERDUE' }).eq('id', inv.id);
      }

      // 3. Decide whether to remind (earlier and more often for risky payers)
      const tier = tiers.get(keyOf(inv.client_name)) ?? 'New';
      const remindFrom = new Date(Date.now() + LEAD_DAYS[tier] * 86400000).toISOString().slice(0, 10);
      if (!overdue && inv.due_date > remindFrom) continue;
      if (inv.reminders_sent >= MAX_REMINDERS) continue;
      const gap = tier === 'Risky' ? Math.min(GAP_DAYS, 1) : GAP_DAYS;
      if (inv.last_reminder_at) {
        const daysSince = (Date.now() - new Date(inv.last_reminder_at)) / 86400000;
        if (daysSince < gap) continue;
      }

      const level = inv.reminders_sent + (tier === 'Risky' ? 1 : 0);
      const tpl = buildReminder(inv, level, overdue);
      const { subject, note } = await draftReminder(inv, level, overdue, tier, tpl);
      console.log('Reminder:', subject, '|', note);
      await sendReminder(inv.paypal_invoice_id, subject, note);
      await supabase.from('invoices').update({
        reminders_sent: inv.reminders_sent + 1,
        last_reminder_at: new Date().toISOString(),
      }).eq('id', inv.id);
        await logEvent('reminder_sent', `${inv.paypal_invoice_id} (#${inv.reminders_sent + 1}, payer tier ${tier})`);
      results.push(`${inv.paypal_invoice_id}: reminder #${inv.reminders_sent + 1}`);
    } catch (e) {
      console.error('Scheduler error on', inv.paypal_invoice_id, e.message);
      results.push(`${inv.paypal_invoice_id}: error`);
    }
  }
   try { 
    results.push(...(await reconcilePayouts())); 
  } catch (e) { console.error('reconcilePayouts', e.message);
   }
  results.push(...(await runAlerts()));
  return results;
}

export function startScheduler() {
  cron.schedule('0 9 * * *', () => runScheduler().then(r => console.log('Scheduler ran:', r)));
  console.log('Scheduler armed: daily at 09:00');
}

  