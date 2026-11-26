# Multi-currency: not supported

Decision of the maintainers: this library keeps every amount as an integer in cents of ONE currency, chosen by the caller.
Requests to convert between currencies, to store a currency per item or to format amounts per locale are out of scope and
are closed as such. A caller that needs conversion does it before building the cart.
