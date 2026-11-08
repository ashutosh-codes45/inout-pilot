import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreClient } from './scores.js';

const inv = (due, paidAt, status = 'PAID', reminders = 0) =>
  ({ due_date: due, paid_at: paidAt, status, reminders_sent: reminders });

test('new client with under 3 invoices is New', () => {
  assert.equal(scoreClient([inv('2026-10-01', '2026-10-01T10:00:00Z')]).tier, 'New');
});
test('on-time payer is Reliable', () => {
  const r = scoreClient([1, 2, 3].map((n) => inv(`2026-0${n}-10`, `2026-0${n}-09T10:00:00Z`)));
  assert.equal(r.tier, 'Reliable');
});
test('repeat late payer with an overdue invoice is Risky', () => {
  const r = scoreClient([
    inv('2026-08-01', '2026-08-15T10:00:00Z', 'PAID', 2),
    inv('2026-09-01', '2026-09-20T10:00:00Z', 'PAID', 3),
    inv('2026-09-15', null, 'OVERDUE', 2),
  ], '2026-10-29');
  assert.equal(r.tier, 'Risky');
});

test('only unpaid, not-yet-due invoices stays New', () => {
  const r = scoreClient([1, 2, 3, 4, 5].map(() => inv('2027-01-01', null, 'SENT')), '2026-10-29');
  assert.equal(r.tier, 'New');
});
test('overdue invoice caps tier at Watch', () => {
  const ontime = [1, 2, 3].map((n) => inv(`2026-0${n}-10`, `2026-0${n}-09T10:00:00Z`));
  const r = scoreClient([...ontime, inv('2026-09-01', null, 'OVERDUE')], '2026-10-29');
  assert.equal(r.tier, 'Watch');
});