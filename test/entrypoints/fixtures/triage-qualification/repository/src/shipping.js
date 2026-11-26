// Shipping. Design: docs/design/shipping.md.
import { subtotal } from './cart.js';

export const freeShippingFrom = 20000;
export const flatRate = 1500;

export function shipping(items) {
  return subtotal(items) >= freeShippingFrom ? 0 : flatRate;
}
