import 'dotenv/config';

const BASE = 'https://api-m.sandbox.paypal.com';

async function getAccessToken() {
  const auth = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
  ).toString('base64');
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`Auth failed ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token;
}

async function paypal(path, method = 'GET', body) {
  const token = await getAccessToken();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `${method} ${path} -> ${res.status} (debug id: ${res.headers.get('paypal-debug-id')})\n${text}`
    );
  }
  return text ? JSON.parse(text) : {};
}

export async function createAndSendInvoice({ clientName, clientEmail, description, amount, dueDate }) {
  const draft = await paypal('/v2/invoicing/invoices', 'POST', {
    detail: {
      invoice_number: `INV-${Date.now()}`,
      currency_code: 'USD',
      note: description,
      payment_term: { term_type: 'DUE_ON_DATE_SPECIFIED', due_date: dueDate }, // YYYY-MM-DD
    },
    invoicer: { business_name: 'Demo Merchant' },
    primary_recipients: [
      { billing_info: { name: { given_name: clientName }, email_address: clientEmail } },
    ],
    items: [
      {
        name: description,
        quantity: '1',
        unit_amount: { currency_code: 'USD', value: String(amount) },
      },
    ],
  });
  const invoiceId = draft.href.split('/').pop();
  await paypal(`/v2/invoicing/invoices/${invoiceId}/send`, 'POST', {
    send_to_recipient: true,
    send_to_invoicer: false,
  });
  return invoiceId;
}

export async function getInvoice(id) {
  return paypal(`/v2/invoicing/invoices/${id}`);
}

export async function verifyWebhook(headers, event) {
  const result = await paypal('/v1/notifications/verify-webhook-signature', 'POST', {
    auth_algo: headers['paypal-auth-algo'],
    cert_url: headers['paypal-cert-url'],
    transmission_id: headers['paypal-transmission-id'],
    transmission_sig: headers['paypal-transmission-sig'],
    transmission_time: headers['paypal-transmission-time'],
    webhook_id: process.env.PAYPAL_WEBHOOK_ID,
    webhook_event: event,
  });
  return result.verification_status === 'SUCCESS';
}

export async function sendReminder(id, subject, note) {
  return paypal(`/v2/invoicing/invoices/${id}/remind`, 'POST', {
    subject,
    note,
    send_to_invoicer: false,
  });
}

// ---- Paying branch: PayPal Payouts API ----
export async function createPayout({ id, email, amount, currency = 'USD', note }) {
  return paypal('/v1/payments/payouts', 'POST', {
    sender_batch_header: {
      sender_batch_id: `PAY-${id}`, // unique per payment: PayPal rejects duplicates
      email_subject: 'You have a payment from Demo Merchant',
      email_message: note || 'Payment from Demo Merchant',
    },
    items: [{
      recipient_type: 'EMAIL',
      receiver: email,
      amount: { currency, value: Number(amount).toFixed(2) },
      note: note || undefined,
      sender_item_id: id,
    }],
  });
}

export async function getPayoutBatch(batchId) {
  return paypal(`/v1/payments/payouts/${batchId}`);
}

export async function sendPayout({ email, amount, currency = 'USD', note, senderItemId }) {
  return paypal('/v1/payments/payouts', 'POST', {
    sender_batch_header: {
      sender_batch_id: `inout-${senderItemId}`,
      email_subject: 'You have a payment',
      email_message: note || 'Payment from your merchant partner',
    },
    items: [{
      recipient_type: 'EMAIL',
      receiver: email,
      amount: { value: amount.toFixed(2), currency },
      note: note || 'Payment',
      sender_item_id: senderItemId,
    }],
  });
}