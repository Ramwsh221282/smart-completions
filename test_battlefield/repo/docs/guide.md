# User and Order Guide

The user service resolves a user by id and returns a display name. The display
name comes from the user record stored in the user repository.

## Orders

An order references a user by id. The order service formats a human readable
summary for an order by combining the order id, the resolved user display name,
and the order total.

## Pricing

The pricing module computes a total price from a list of item prices, applies a
percentage discount, and formats an amount with a currency code.
