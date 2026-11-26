// The cart total. Design: docs/design/cart-total.md.
export function subtotal(items) {
  return items.reduce((sum, item) => sum + item.price, 0);
}

export function total(items, coupon) {
  const amount = subtotal(items);
  return coupon ? amount - coupon.value : amount;
}
