import assert from 'node:assert/strict';
import { test } from 'node:test';
import { total } from '../src/cart.js';
import { toCsv } from '../src/export.js';

test('a cart of single items sums their prices', () => {
  assert.equal(total([{ price: 1000 }, { price: 250 }]), 1250);
});

test('a coupon is subtracted', () => {
  assert.equal(total([{ price: 1000 }], { value: 300 }), 700);
});

test('the cart is exported as CSV', () => {
  assert.equal(toCsv([{ name: 'tea, green', price: 500, quantity: 2 }]), 'name,price,quantity\n"tea, green",500,2');
});
