# Settrade UAT / Fault Test Matrix

Public test specification only. Runtime results, broker identifiers, account
state, order details, timestamps and evidence hashes must remain on the private
worker and must not be committed to a public repository.

| # | Test case | Required fail-safe outcome |
|---:|---|---|
| 1 | Environment missing or inconsistent | Refuse to start |
| 2 | Production gate incomplete | Refuse every mutation |
| 3 | Gateway token invalid | Return 401 without account data |
| 4 | Cleartext remote gateway | Client rejects connection |
| 5 | Invalid symbol, quantity or price | Reject before broker call |
| 6 | Unsupported ATO/MP/IOC/FOK style | Permit Limit + Day only |
| 7 | Missing idempotency key | Reject |
| 8 | Same key and same payload | Return prior result without resubmission |
| 9 | Same key and different payload | Reject |
| 10 | Broker response lacks order number | Mark execution uncertain; never retry |
| 11 | Network timeout during submission | Mark execution uncertain; reconcile only |
| 12 | Authentication error during mutation | Never retry the mutation |
| 13 | Crash before or after broker acceptance | Restart in reconcile-only mode |
| 14 | Concurrent session or second worker | Stop mutations and alert |
| 15 | Matching open order already exists | Reject duplicate submission |
| 16 | Auction, lunch break or closed market | Do not submit |
| 17 | Missing, inverted or wide quote | Do not submit |
| 18 | Price drift exceeds limit | Do not submit |
| 19 | Cash reserve or position cap breach | Do not submit |
| 20 | Daily order/value cap breach | Do not submit |
| 21 | Partial fill | Persist matched quantity until terminal |
| 22 | Order cannot be cancelled | Do not send cancel |
| 23 | Cancel cannot be confirmed | Mark execution uncertain |
| 24 | Worker loses network after approval | Preserve intent; no automatic retry |
| 25 | Alert channel unavailable | Keep production locked |

## Evidence policy

- Exercise every production-path failure in Sandbox/UAT or a deterministic
  fault-injection harness before a real-money pilot.
- Store request IDs, broker order references, timestamps, before/after states
  and sanitized logs only on the private machine.
- Never store PINs, API secrets, tokens, account numbers, portfolio holdings or
  live account snapshots in Git.
- Unit tests do not replace broker UAT. An operational pilot remains locked
  until the private evidence set is complete and independently reviewed.
