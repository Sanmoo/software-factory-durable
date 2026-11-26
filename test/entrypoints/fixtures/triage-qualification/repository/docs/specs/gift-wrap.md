# Specification: gift wrap (version 1)

Status: approved. The approval of this version is recorded by a maintainer on the Ticket that asks for it.

## Behaviour

1. An item may carry `giftWrap: true`.
2. Each wrapped item adds 300 cents to the subtotal, once per item line, whatever its quantity.
3. The gift wrap amount is part of the subtotal: it counts for free shipping and is reduced by a coupon like the rest.
4. `subtotal(items)` in `src/cart.js` is the only place that computes it.

## Verification

A cart with one wrapped line of quantity 2 and price 1000 has a subtotal of 2300. A cart without wrapped items is unchanged.
