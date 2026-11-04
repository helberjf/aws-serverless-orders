# Architecture decisions

## ADR 001 — Durable transactional outbox

An order and its `OrderCreated` intent are written with the idempotency response in one DynamoDB transaction. Processing atomically updates the order, creates one fulfillment ticket, and records `OrderProcessed`. Publishing is a separate, retryable operation. The outbox stream is the low-latency trigger; a scheduled query of `PendingByNextAttempt` recovers committed work even after stream records expire.

Publishers take a conditional 120-second lease. Failed attempts receive exponential backoff, capped at one hour, so a poison record cannot permanently occupy the front of the recovery query. Pending records never receive a TTL. Only delivered outbox records expire after seven days. External publication followed by recording success cannot be made atomic: an ambiguous response or a crash can cause another delivery. Stable business event IDs and idempotent consumers are required throughout.

## ADR 002 — HTTP and consumer idempotency

`Idempotency-Key` is scoped to the authenticated owner and hashed before storage. A repeated normalized payload returns the original `201` response; a different payload with the same unexpired key receives `409`. The response and order commit atomically. Records expire logically after 24 hours; the conditional write handles DynamoDB's delayed physical TTL deletion. For backward compatibility, missing keys create a new key and return it in the response. Safe HTTP retries must supply the same key.

SQS duplicates cannot create additional fulfillment tickets: the order transition, uniquely keyed ticket, and event intent form one conditional transaction. `updatedAt` also guards concurrent changes. An ambiguous transaction failure is reconciled with a consistent read before deciding whether to retry. Missing orders and unexpected states fail the individual message.

## ADR 003 — A concrete, bounded business operation

Processing creates a durable fulfillment ticket containing the product and quantity to prepare. `PROCESSED` means ready for fulfillment, not paid or shipped. The operation has no artificial delay or invented payment result. A separate `PROCESSING` state is unnecessary for a single atomic transaction and would add a recovery lease with no external work to protect. Payment, stock reservation, and shipping require their own domain rules before being added.

## ADR 004 — Step Functions is excluded from this workflow

There is currently one atomic business operation followed by event delivery. A state machine around it would duplicate the SQS retry policy and DynamoDB transaction without introducing a meaningful orchestration boundary. A future payment/reservation/compensation saga would justify Tasks, Choice, Retry, and Catch. No Step Functions functionality or deployment is claimed in this implementation.
