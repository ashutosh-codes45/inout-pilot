import test from 'node:test';
import assert from 'node:assert/strict';
import { decide } from './policy.js';

const partner = { name: 'Acme', auto_limit: 100, blocked: false };

test('auto-pays a known partner under the limit', () => {
  assert.equal(decide({ amount: 50, partner, paidToday: 0 }).decision, 'AUTO');
});
test('asks for a new recipient', () => {
  assert.equal(decide({ amount: 20, partner: null, paidToday: 0 }).decision, 'ASK');
});
test('asks when above the partner limit', () => {
  assert.equal(decide({ amount: 300, partner, paidToday: 0 }).decision, 'ASK');
});
test('blocks above the hard limit', () => {
  assert.equal(decide({ amount: 5000, partner, paidToday: 0 }).decision, 'BLOCK');
});
test('blocks a blocked partner', () => {
  assert.equal(decide({ amount: 10, partner: { ...partner, blocked: true }, paidToday: 0 }).decision, 'BLOCK');
});
test('blocks when the daily cap would be exceeded', () => {
  assert.equal(decide({ amount: 90, partner, paidToday: 1450 }).decision, 'BLOCK');
});
test('blocks invalid amounts', () => {
  assert.equal(decide({ amount: -5, partner, paidToday: 0 }).decision, 'BLOCK');
  assert.equal(decide({ amount: NaN, partner, paidToday: 0 }).decision, 'BLOCK');
});