import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStatus } from './status.js';

const invoices = [
  { id: 'i1', client_name: 'Gamma Co', amount: 60, due_date: '2026-11-20', paypal_invoice_id: 'INV2-A', status: 'SENT' },
  { id: 'i2', client_name: 'Alpha Traders', amount: 30, due_date: '2026-11-01', paypal_invoice_id: 'INV2-B', status: 'OVERDUE' },
];
const payments = [
  { id: 'p1', supplier_name: 'Singha', amount: 12, status: 'WAITING_FOR_CLIENT', linked_invoice_id: 'i1', due_date: '2026-11-10', alerted_at: '2026-11-08' },
  { id: 'p2', supplier_name: 'Acme', amount: 300, status: 'PENDING_APPROVAL', reason: 'Over auto-pay limit' },
];
const scores = [{ client_name: 'Alpha Traders', tier: 'Risky' }, { client_name: 'Gamma Co', tier: 'New' }];
const s = buildStatus({ invoices, payments, scores, today: '2026-11-09' });

test('totals come from the data', () => {
  assert.equal(s.totals.owed, 90);
  assert.equal(s.totals.overdue, 30);
  assert.equal(s.totals.waiting_payouts, 12);
  assert.equal(s.totals.awaiting_approval, 300);
});
test('flags overdue, at-risk payouts and risky payers', () => {
  assert.equal(s.receivables.find((r) => r.client === 'Alpha Traders').days_overdue, 8);
  assert.equal(s.waiting_payouts[0].at_risk, true);
  assert.equal(s.waiting_payouts[0].waiting_on, 'Gamma Co');
  assert.match(s.summary, /Risky payers: Alpha Traders/);
});
test('empty state is readable', () => {
  const e = buildStatus({ invoices: [], payments: [], scores: [], today: '2026-11-09' });
  assert.match(e.summary, /Nothing needs your attention/);
});

test('focus summaries are separate and grammar is right', () => {
  assert.match(s.summaries.payables, /1 payout needs your approval/);
  assert.doesNotMatch(s.summaries.payables, /owed/);
  assert.doesNotMatch(s.summaries.receivables, /supplier payouts/);
  const two = buildStatus({ invoices: [], payments: [payments[1], { ...payments[1], id: 'p3' }], scores: [], today: '2026-11-09' });
  assert.match(two.summaries.payables, /2 payouts need your approval/);
});