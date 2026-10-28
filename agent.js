import 'dotenv/config';
import { issueInvoice } from './invoices.js';
import { requestPayout } from './payments.js';
import { logEvent } from './db.js';

// Free LLM via any OpenAI-compatible endpoint. Defaults to Groq's free tier.
// To use OpenRouter instead: LLM_BASE_URL=https://openrouter.ai, LLM_MODEL=openai/gpt-oss-120b:free
const BASE_URL = process.env.LLM_BASE_URL ?? 'https://groq.com';
const MODEL = process.env.LLM_MODEL ?? 'openai/gpt-oss-120b';

const toolDefs = [
  {
    name: 'create_invoice',
    description: 'Receiving money: create and send an invoice to a client.',
    input_schema: {
      type: 'object',
      properties: {
        client_name: { type: 'string' },
        client_email: { type: 'string' },
        description: { type: 'string', description: 'What the invoice is for' },
        amount: { type: 'number', description: 'USD' },
        due_date: { type: 'string', description: 'YYYY-MM-DD' },
      },
      required: ['client_name', 'client_email', 'description', 'amount', 'due_date'],
    },
  },
  {
    name: 'request_payout',
    description: 'Paying money: ask to pay a supplier. Use the supplier NAME only; never invent an email.',
    input_schema: {
      type: 'object',
      properties: {
        supplier: { type: 'string', description: 'Supplier name as the merchant wrote it' },
        amount: { type: 'number', description: 'USD' },
        note: { type: 'string' },
        after_client_pays: { type: 'string', description: 'Only if the merchant says to pay once a client pays: the client name or PayPal invoice id (INV2-...)' },
        supplier_due_date: { type: 'string', description: 'YYYY-MM-DD, when the supplier payment is due' },
      },
      required: ['supplier', 'amount'],
    },
  },
  {
    name: 'ask_clarification',
    description: 'Use when the request is missing required details or is neither receiving nor paying money.',
    input_schema: {
      type: 'object',
      properties: { question: { type: 'string' } },
      required: ['question'],
    },
  },
];

const tools = toolDefs.map(({ name, description, input_schema }) => ({
  type: 'function',
  function: { name, description, parameters: input_schema },
}));

const isEmail = (s) => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const posNum = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0 && n < 1e7;

// The model only extracts fields. Code validates them and runs the real actions.
const handlers = {
  async create_invoice(i) {
    const today = new Date().toISOString().slice(0, 10);
    if (!i.client_name?.trim()) throw new Error('client_name missing');
    if (!isEmail(i.client_email)) throw new Error('client_email invalid');
    if (!posNum(i.amount)) throw new Error('amount invalid');
    if (!isDate(i.due_date) || i.due_date < today) throw new Error('due_date must be YYYY-MM-DD and not in the past');
    return issueInvoice({
      clientName: i.client_name.trim(), clientEmail: i.client_email,
      description: (i.description ?? 'Services').trim(), amount: i.amount, dueDate: i.due_date,
    });
  },
  async request_payout(i) {
    if (!i.supplier?.trim()) throw new Error('supplier missing');
    if (!posNum(i.amount)) throw new Error('amount invalid');
    if (i.supplier_due_date && !isDate(i.supplier_due_date)) throw new Error('supplier_due_date must be YYYY-MM-DD');
    return requestPayout({
      supplierName: i.supplier, amount: i.amount, note: i.note ?? '',
      afterPaid: i.after_client_pays?.trim() || null,
      supplierDueDate: i.supplier_due_date || null,
    });
  },
  async ask_clarification(i) {
    return { question: i.question };
  },
};

export async function handleMerchantRequest(message) {
  const text = String(message ?? '').trim().slice(0, 2000);
  if (!text) throw new Error('Empty request');
  await logEvent('agent_request', text.slice(0, 200));

  const today = new Date().toISOString().slice(0, 10);
  if (!process.env.LLM_API_KEY) throw new Error('LLM_API_KEY is not set');

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.LLM_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      max_tokens: 1024,
      tools,
      tool_choice: 'required',
      messages: [
        {
          role: 'system',
          content:
            `You route a small merchant's requests. Today is ${today}. ` +
            `Receiving money -> create_invoice. Paying a supplier -> request_payout. ` +
            `If the merchant says to pay a supplier only after or when a client pays, set after_client_pays. ` +
            `If anything required is missing or ambiguous, call ask_clarification instead of guessing. ` +
            `Resolve relative dates ("in 2 weeks") to YYYY-MM-DD. ` +
            `You do not decide whether payments are allowed; a policy engine does.`,
        },
        { role: 'user', content: text },
      ],
    }),
  });
  if (!res.ok) throw new Error(`LLM error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const msg = (await res.json()).choices?.[0]?.message;

  const results = [];
  for (const call of (msg?.tool_calls ?? []).slice(0, 3)) {
    const name = call.function?.name;
    try {
      if (!handlers[name]) throw new Error(`Unknown action: ${name}`);
      let args;
      try { args = JSON.parse(call.function.arguments || '{}'); }
      catch { throw new Error('Model returned malformed arguments'); }
      results.push({ action: name, ok: true, result: await handlers[name](args) });
    } catch (e) {
      await logEvent('agent_error', `${name}: ${e.message.slice(0, 200)}`);
      results.push({ action: name, ok: false, error: e.message });
    }
  }
  if (!results.length) results.push({ action: 'ask_clarification', ok: true, result: { question: 'Sorry, I could not understand that. Is this an invoice to send or a supplier payment?' } });
  return results;
}
