# Architecture decisions

## ADR 001 — Durable transactional outbox

An order and its `OrderCreated` intent are written with the idempotency response in one DynamoDB transaction. Processing atomically updates the order, creates one fulfillment ticket, and records `OrderProcessed`. Publishing is a separate, retryable operation. The outbox stream is the low-latency trigger; a scheduled query of `PendingByNextAttempt` recovers committed work even after stream records expire. Lease acquisition checks the retry deadline atomically, so a worker with an older read cannot bypass another publisher's newly scheduled backoff.

Publishers take a conditional 120-second lease. Failed attempts receive exponential backoff, capped at one hour, so a poison record cannot permanently occupy the front of the recovery query. Pending records never receive a TTL. Only delivered outbox records expire after seven days. External publication followed by recording success cannot be made atomic: an ambiguous response or a crash can cause another delivery. Stable business event IDs and idempotent consumers are required throughout.

## ADR 002 — HTTP and consumer idempotency

`Idempotency-Key` is scoped to the authenticated owner and hashed before storage. A repeated normalized payload returns the original `201` response; a different payload with the same unexpired key receives `409`. The response and order commit atomically. Records expire logically after 24 hours; the conditional write handles DynamoDB's delayed physical TTL deletion. For backward compatibility, missing keys create a new key and return it in the response. Safe HTTP retries must supply the same key.

SQS duplicates cannot create additional fulfillment tickets: the order transition, uniquely keyed ticket, and event intent form one conditional transaction. `updatedAt` also guards concurrent changes. An ambiguous transaction failure is reconciled with a consistent read before deciding whether to retry. Missing orders and unexpected states fail the individual message.

## ADR 003 — A concrete, bounded business operation

Processing creates a durable fulfillment ticket containing the product and quantity to prepare. `PROCESSED` means ready for fulfillment, not paid or shipped. The operation has no artificial delay or invented payment result. A separate `PROCESSING` state is unnecessary for a single atomic transaction and would add a recovery lease with no external work to protect. Payment, stock reservation, and shipping require their own domain rules before being added.

## ADR 004 — Step Functions is excluded from this workflow

There is currently one atomic business operation followed by event delivery. A state machine around it would duplicate the SQS retry policy and DynamoDB transaction without introducing a meaningful orchestration boundary. A future payment/reservation/compensation saga would justify Tasks, Choice, Retry, and Catch. No Step Functions functionality or deployment is claimed in this implementation.

## ADR 005 — Notification fan-out uses the same durable publication boundary

EventBridge routes `OrderProcessed` to a dedicated SQS queue. A notification consumer validates the business event, then atomically stores a receipt and a notification outbox record. A permanent receipt prevents late event replay from recreating a business notification after published outbox entries expire. A conflicting payload under the same business ID is retried and becomes operationally visible rather than silently accepted.

SNS Standard fans out to an audit queue without requiring a real email address. A confirmed test email is optional. The receipt is a business-level deduplication boundary, not a guarantee of one physical SNS delivery: publishing and acknowledgment persistence remain non-atomic, and subscribers must deduplicate stable event IDs. An indefinitely retained receipt has a storage/deletion cost that future business requirements must resolve.

## ADR 006 — Explicit tables and access patterns

| Table                | Partition key              | Access pattern                                                   | Retention                                       |
| -------------------- | -------------------------- | ---------------------------------------------------------------- | ----------------------------------------------- |
| Orders               | `orderId`                  | Consistent GetItem; conditional final transition                 | Durable, retained/PITR                          |
| Fulfillments         | `orderId`                  | Unique conditional ticket creation; operator lookup              | Durable, retained/PITR                          |
| Idempotency          | Hash of owner + client key | Consistent replay lookup; conditional reuse after logical expiry | 24-hour TTL                                     |
| Outbox               | `eventId`                  | Stream-triggered Get/Update; Query `PendingByNextAttempt`        | Pending never expires; published TTL seven days |
| NotificationReceipts | Stable processed-event ID  | Conditional put; consistent reconciliation read                  | Durable, no TTL                                 |

On-demand capacity fits an intermittent lab. Separate tables make authorization, retention and the transactional boundary easy to review. They add deployment resources but not provisioned idle capacity. Transactions and the GSI increase per-order request cost. The recovery index partitions by delivery status and sorts by `nextAttemptAt`; its single pending partition is a deliberate low-volume choice, not an unlimited scaling claim. Sharding, backpressure and faster bulk recovery would need measurement before a larger deployment.

## ADR 007 — Cognito access tokens and ownership

The former IAM API is migrated to Cognito because this is a user-facing order boundary. API Gateway validates signatures; handlers check access-token claims, client, issuer, expiry and scopes. `ownerId` is the subject, while `customerId` remains business input. Cross-owner reads are indistinguishable from missing rows. The code never falls back to body ownership or old IAM identity.

This requires a reviewed migration for legacy clients/rows. An authorization-code public client with PKCE avoids committing a secret. Optional TOTP and admin-created users support a controlled demonstration. No third-party secret exists, so Secrets Manager/SSM is deferred until there is one to protect. [Security boundaries](security.md) documents trust assumptions and IAM exceptions.

## ADR 008 — Observable failures without high-cardinality metrics

Powertools provides JSON logs, embedded metrics and AWS SDK tracing. Business identifiers belong in logs/traces, while custom metrics use only a stack-level service dimension. This avoids a billable metric for each order/customer. Partial batch failures and handled HTTP 500 responses increment an application failure metric because Lambda's native Errors metric does not capture all of them. API stage metrics drive the 5xx rate alarm; detailed per-method metrics are unnecessary for the lab.

Log retention is fourteen days. Optional email alarms use a customer-managed KMS key only when requested; default service-managed encryption avoids unnecessary key charges. Full end-to-end trace continuity across durable asynchronous retries is not claimed.

## ADR 009 — Reviewable OIDC deployment and HTTP canaries

Build/review and execution have separate OIDC roles. The plan artifact binds the stack, environment, revision and Change Set ARN; the apply script checks those against AWS before execution. GitHub's production environment provides the manual approval gate after the plan is visible, and a preflight validates its protection settings. Infrastructure administration is still privileged; isolated accounts and trusted repository governance remain necessary.

HTTP handlers use immutable versions behind `live`, with `Canary10Percent10Minutes`. The API integration must point at the alias, which is tested against the SAM expansion. Native Lambda and API 5xx alarms govern rollback. The first deployment and low traffic cannot prove canary behavior; a second deployment with observed traffic and an isolated fault exercise is required. Worker updates remain immediate and must be message/schema compatible.

## ADR 010 — One dependency root and meaningful test layers

One lockfile avoids seven independently drifting dependency trees. esbuild produces a separate deployable handler bundle. Vitest replaces the legacy Jest/ts-jest combination and provides native TypeScript/ESM support with V8 coverage. Unit tests mock AWS; DynamoDB Local tests exercise real conditional transactions; SAM transformation tests inspect generated resources; live tests remain explicitly separate.

The temporary `minimatch` override to 11.0.4 resolves the advisory affecting the transitive lint toolchain. Type checking, lint, unit/integration tests and SAM builds passed with it. Remove the override when upstream dependency ranges adopt a patched compatible version. Installation scripts are explicitly allowed only for the pinned esbuild version. npm auditing and a basic credential-pattern scan run in CI; neither is a comprehensive supply-chain/security audit.
