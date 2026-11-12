import test from 'node:test';
import assert from 'node:assert/strict';
import { computeShift, MAX_SHIFT_DAYS } from './shift.js';

const invoice = (over = {}) => ({
  id: 'inv-1', status: 'SENT', due_date: '2026-11-10', expected_pay_date: null, ...over,
});
const payout = (over = {}) => ({
  id: 'pay-1', status: 'WAITING_FOR_CLIENT', planned_date: null, due_date: '2026-11-12', ...over,
});

test('refuses to shift a paid invoice', () => {
  assert.throws(() => computeShift(invoice({ status: 'PAID' }), [], '2026-11-20'), /paid invoice cannot be rescheduled/i);
});

test('rejects a date that is not YYYY-MM-DD', () => {
  assert.throws(() => computeShift(invoice(), [], 'next tuesday'), /YYYY-MM-DD/);
});

test('needs something to shift from', () => {
  assert.throws(() => computeShift(invoice({ due_date: null }), [], '2026-11-20'), /no expected_pay_date or due_date/);
});

test('limits a move forwards to +60 days', () => {
  const out = computeShift(invoice(), [], '2027-06-01');
  assert.equal(out.days, MAX_SHIFT_DAYS);
  assert.equal(out.invoice.expected_pay_date, '2027-01-09'); // 2026-11-10 + 60
});

test('limits a move backwards to -60 days', () => {
  const out = computeShift(invoice(), [], '2020-01-01');
  assert.equal(out.days, -MAX_SHIFT_DAYS);
  assert.equal(out.invoice.expected_pay_date, '2026-09-11'); // 2026-11-10 - 60
});

test('moves a waiting payout by the same days, keeping its lag', () => {
  const out = computeShift(
    invoice({ expected_pay_date: '2026-11-10' }),
    [payout({ planned_date: '2026-11-14', due_date: '2026-11-20' })],
    '2026-11-15',
  );
  assert.equal(out.days, 5);
  assert.equal(out.invoice.expected_pay_date, '2026-11-15');
  assert.equal(out.payouts[0].planned_date, '2026-11-19'); // 2026-11-14 + 5 days
  assert.equal(out.payouts[0].conflict, false);
});

test('flags a conflict when the payout lands after its supplier due date', () => {
  const out = computeShift(
    invoice({ expected_pay_date: '2026-11-10' }),
    [payout({ planned_date: '2026-11-10', due_date: '2026-11-12' })],
    '2026-11-15',
  );
  assert.equal(out.payouts[0].planned_date, '2026-11-15');
  assert.equal(out.payouts[0].due_date, '2026-11-12');
  assert.equal(out.payouts[0].conflict, true);
});

test('a payout without a planned date follows the invoice', () => {
  const out = computeShift(invoice({ expected_pay_date: '2026-11-10' }), [payout()], '2026-11-13');
  assert.equal(out.payouts[0].planned_date, '2026-11-13');
});

test('ignores payouts that are not waiting for the client', () => {
  const out = computeShift(
    invoice({ expected_pay_date: '2026-11-10' }),
    [payout({ id: 'pay-2', status: 'SUCCESS', planned_date: '2026-11-11' }), payout({ id: 'pay-3', status: 'CANCELLED' })],
    '2026-11-20',
  );
  assert.deepEqual(out.payouts, []);
});

test('falls back to due_date when there is no expected_pay_date', () => {
  const out = computeShift(invoice(), [], '2026-11-17');
  assert.equal(out.days, 7);
  assert.equal(out.invoice.expected_pay_date, '2026-11-17');
});
