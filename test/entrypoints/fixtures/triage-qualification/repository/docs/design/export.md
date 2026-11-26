# Export (established design)

`toCsv(items)` in `src/export.js` returns the cart as CSV text: a header line `name,price,quantity`, then one line per item, in
the order of the cart. A name that contains a comma or a double quote is quoted, with double quotes doubled. This is the whole
export feature: there is no other format.
