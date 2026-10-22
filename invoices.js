import { createAndSendInvoice, getInvoice } from './paypal.js';
import { saveInvoice, logEvent } from './db.js';

/** Receiving branch: create -> send -> save. */
export async function issueInvoice({ clientName, clientEmail, description, amount, dueDate }) {
  const id = await createAndSendInvoice({ clientName, clientEmail, description, amount, dueDate });
  try {
    await saveInvoice({
      paypal_invoice_id: id, client_name: clientName, client_email: clientEmail,
      description, amount, due_date: dueDate,
    });
  } catch (e) {
    // Invoice already went out; make sure it's findable even if the DB write failed.
    await logEvent('invoice_save_failed', `${id}: ${e.message}`);
    throw e;
  }
  const inv = await getInvoice(id);
  return { invoiceId: id, status: inv.status, payLink: inv.detail?.metadata?.recipient_view_url };
}