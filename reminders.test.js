import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReminder, draftReminder } from './reminders.js';

const inv = { client_name: 'Gamma Co', amount: 60, currency: 'USD', description: 'signage', due_date: '2026-11-20' };
const fallback = { subject: 'fallback subject', note: 'fallback note' };
const good = { subject: 'Reminder: signage invoice', note: 'Hi Gamma Co, a quick reminder that your $60 invoice for signage is due on 2026-11-20. Thank you!' };

test('accepts a clean reminder that states the amount', () => {
  assert.deepEqual(validateReminder(good, inv), good);
});
test('rejects invented fees', () => {
  assert.equal(validateReminder({ ...good, note: 'Pay $60 now or a late fee applies.' }, inv), null);
});
test('rejects a note without the real amount', () => {
  assert.equal(validateReminder({ ...good, note: 'Please pay your invoice soon.' }, inv), null);
});
test('rejects links and threats', () => {
  assert.equal(validateReminder({ ...good, note: 'Pay $60 at https://evil.example' }, inv), null);
  assert.equal(validateReminder({ ...good, note: 'Pay $60 or we will take legal action' }, inv), null);
});

const withFetch = async (impl, fn) => {
  const real = globalThis.fetch;
  process.env.LLM_API_KEY = 'test';
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = real; }
};
const reply = (content, finish = 'stop') => async () => ({ ok: true, json: async () => ({ choices: [{ finish_reason: finish, message: { content } }] }) });

test('uses the AI draft when it is valid', async () => {
  const r = await withFetch(reply('```json\n' + JSON.stringify(good) + '\n```'), () => draftReminder(inv, 0, false, 'New', fallback));
  assert.deepEqual(r, good);
});
test('falls back on invalid facts, truncated output, bad JSON or errors', async () => {
  const bad = { subject: 'x', note: 'Pay now or face a penalty of $5' };
  assert.deepEqual(await withFetch(reply(JSON.stringify(bad)), () => draftReminder(inv, 0, false, 'New', fallback)), fallback);
  assert.deepEqual(await withFetch(reply(JSON.stringify(good), 'length'), () => draftReminder(inv, 0, false, 'New', fallback)), fallback);
  assert.deepEqual(await withFetch(reply('not json'), () => draftReminder(inv, 0, false, 'New', fallback)), fallback);
  assert.deepEqual(await withFetch(async () => { throw new Error('down'); }, () => draftReminder(inv, 0, false, 'New', fallback)), fallback);
});

test('rejects phone numbers but allows ISO dates', () => {
  assert.equal(validateReminder({ ...good, note: 'Pay $60, call +1 555 123 4567' }, inv), null);
  assert.deepEqual(validateReminder(good, inv), good);
});