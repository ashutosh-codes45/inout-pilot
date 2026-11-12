// Pure scheduling maths for moving an invoice's expected pay date and every supplier
// payout that is waiting on that invoice. No I/O and no database, so it is easy to test.

const DAY = 86400000;

/** An invoice may never be pushed more than two months at a time. */
export const MAX_SHIFT_DAYS = 60;

/** Parse a date-only value (YYYY-MM-DD, or an ISO timestamp) into a UTC midnight Date. */
export function toDay(value) {
  if (!value) return null;
  const s = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return Number.isNaN(date.getTime()) ? null : date;
}

const isoDay = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * DAY);
const daysBetween = (a, b) => Math.round((a.getTime() - b.getTime()) / DAY);

/**
 * Work out where an invoice and its waiting payouts should move to.
 *
 * @param {object}   invoice           invoice row: id, status, due_date, expected_pay_date
 * @param {object[]} payouts           payout rows linked to that invoice
 * @param {string}   newExpectedDate   requested new expected pay date, 'YYYY-MM-DD'
 * @returns {{invoice:{id:*,expected_pay_date:string}, days:number,
 *            payouts:{id:*,planned_date:string,due_date:?string,conflict:boolean}[]}}
 * @throws when the invoice is paid, the date is malformed, or there is nothing to shift from
 */
export function computeShift(invoice, payouts, newExpectedDate) {
  if (!invoice) throw new Error('An invoice is required');
  if (invoice.status === 'PAID') throw new Error('A paid invoice cannot be rescheduled');

  const target = toDay(newExpectedDate);
  if (!target) throw new Error('expected_pay_date must be a YYYY-MM-DD date');

  const current = toDay(invoice.expected_pay_date) ?? toDay(invoice.due_date);
  if (!current) throw new Error('The invoice has no expected_pay_date or due_date to shift from');

  // Never move an invoice more than two months in one go.
  const requested = daysBetween(target, current);
  const days = Math.max(-MAX_SHIFT_DAYS, Math.min(MAX_SHIFT_DAYS, requested));
  const expected = addDays(current, days);

  const shifted = (payouts ?? [])
    .filter((p) => p?.status === 'WAITING_FOR_CLIENT')
    .map((p) => {
      // A payout with no planned date simply follows the invoice, so its lag is zero.
      const planned = toDay(p.planned_date) ?? current;
      const plannedDate = addDays(planned, days);
      const due = toDay(p.due_date);
      return {
        id: p.id,
        planned_date: isoDay(plannedDate),
        due_date: p.due_date ?? null,
        conflict: Boolean(due && plannedDate > due),
      };
    });

  return {
    invoice: { id: invoice.id, expected_pay_date: isoDay(expected) },
    days,
    payouts: shifted,
  };
}
