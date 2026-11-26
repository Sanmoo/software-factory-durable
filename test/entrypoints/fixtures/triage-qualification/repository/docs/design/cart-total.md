# Cart total (established design)

Decided by the maintainers; `src/cart.js` must behave exactly like this.

1. The subtotal is the sum of `price * quantity` over the items. A missing `quantity` counts as 1.
2. A coupon has a fixed `value`. The total is the subtotal minus the coupon value.
3. The total is never negative: a coupon larger than the subtotal gives a total of 0.
4. Amounts are integers in cents. There is no rounding anywhere.
