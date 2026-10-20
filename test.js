import { createAndSendInvoice, getInvoice } from './paypal.js';
import { saveInvoice } from './db.js';

const due = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
const details = {
  clientName: 'Test Client',
  clientEmail: process.env.CLIENT_EMAIL,
  description: 'Logo design',
  amount: 50,
  dueDate: due,
};
const id = await createAndSendInvoice(details);
const inv = await getInvoice(id);
await saveInvoice({
  paypal_invoice_id: id,
  client_name: details.clientName,
  client_email: details.clientEmail,
  description: details.description,
  amount: details.amount,
  due_date: details.dueDate,
});
console.log('Invoice ID:', id, '| Status:', inv.status, '| saved to database');
console.log('Pay link:', inv.detail?.metadata?.recipient_view_url);