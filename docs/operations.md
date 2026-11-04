# Operations and recovery

Start with the stack's `DashboardUrl` output. Correlate by `orderId`, then by `eventId`, `messageId` and `requestId`. Never copy tokens, entire request bodies or customer data into incident notes. The health route is a liveness endpoint, not a test of DynamoDB/SQS availability.

## Signals and alarms

| Signal                                   | Interpretation and first check                                                                             |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Lambda Errors/Throttles                  | Unhandled failure, timeout or concurrency pressure; inspect the affected function and account quota        |
| `AWSOrders/OperationFailures`            | Includes caught HTTP errors and individual failed batch records; useful when Lambda itself reports success |
| API 5xx rate                             | More than 1% in a one-minute interval; also watches handled HTTP 500 responses during canaries             |
| Orders/notification visible backlog ≥100 | Capacity or dependency problem; compare processing rate and throttles                                      |
| Oldest message >300 seconds              | Work is not keeping up; inspect consumers and DLQs                                                         |
| DLQ/failure-metadata depth ≥1            | Retries exhausted or a routing/subscription delivery failed                                                |
| Publisher iterator age ≥60 seconds       | Stream processing is behind; durable recovery still relies on the outbox table                             |

Queue depth and age metrics are approximate. Poison-message treatment and in-flight messages can make visible depth differ from total outstanding work. Alarm email is off by default; configured alarms still evaluate and participate in CodeDeploy rollback without email actions. Confirm optional SNS subscriptions before expecting alerts.

CloudWatch Logs Insights examples (select this stack's Lambda log groups and a narrow time range):

```sql
fields @timestamp, eventType, orderId, eventId, requestId, messageId, status, durationMs, errorType
| filter orderId = "d73b82b5-bcf4-4aae-a3b3-0e726019f8e0"
| sort @timestamp asc
```

```sql
fields @timestamp, eventType, messageId, requestId, errorType
| filter level = "ERROR"
| stats count(*) as failures by eventType, errorType, bin(5m)
```

```sql
filter eventType = "invocation_completed"
| stats count(*) as invocations, pct(durationMs, 95) as p95_ms by operation, bin(5m)
```

X-Ray captures sampled HTTP/function/AWS SDK activity. Outbox records can be dispatched by a different invocation minutes later; use business IDs to bridge separate traces. Logs have fourteen-day retention, so export only approved diagnostic evidence before it expires.

## Order remains RECEIVED

1. Read the specific order consistently by `orderId`; verify the expected schema and owner. Do not scan the table to diagnose one order.
2. Read `OrderCreated:<orderId>` in OutboxTable. If pending, inspect its attempts, next attempt time and any lease. If missing and the order predates the outbox migration, use the migration procedure.
3. If published, inspect OrdersQueue and OrdersDeadLetterQueue, the ProcessOrder logs, IAM failures and concurrency alarms. Published means accepted by SQS, not successfully processed.
4. A failed transaction leaves the order, fulfillment and `OrderProcessed` intent unchanged. Fix the underlying data, code, permission or capacity issue before redrive.
5. Once `PROCESSED`, confirm the fulfillment ticket and notification path. Never reset a final order to RECEIVED to repeat processing.

If all transport copies expired, a published outbox record is not a consumer-completion tracker. After verifying the known order is still RECEIVED and valid, an operator can re-enqueue its order ID. Keep the original ID and do not recreate the HTTP order. This is an explicit recovery action, not an automatic scan-based replay.

## Durable outbox recovery

The scheduled ReconcileOutbox handler queries `PendingByNextAttempt` with `deliveryStatus=PENDING` and `nextAttemptAt<=now`. It attempts at most forty records per run. Successful acknowledgments set PUBLISHED and a seven-day TTL. Pending work has no TTL; physical deletion of expired DynamoDB records is asynchronous.

To inspect due work, set `OUTBOX_TABLE` from the stack output and create a local JSON values file with the current UTC timestamp:

```json
{
  ":pending": { "S": "PENDING" },
  ":now": { "S": "2026-11-04T12:00:00.000Z" }
}
```

```bash
aws dynamodb query --table-name "$OUTBOX_TABLE" --index-name PendingByNextAttempt --key-condition-expression 'deliveryStatus = :pending AND nextAttemptAt <= :now' --expression-attribute-values file://due-values.json --limit 20 --region sa-east-1
```

Use a fresh timestamp, not the illustrative one. The GSI is eventually consistent; dispatch performs a consistent item read and conditional lease before sending. Do not manually clear a live lease. An interrupted invocation becomes eligible after its 120-second lease. Failed sends back off from 30 seconds up to one hour; the five-minute scheduler adds recovery latency.

PublishFailuresQueue contains DynamoDB stream failure metadata, not directly replayable order messages. Investigate the stream batch metadata and outbox state; do not redrive those records into OrdersQueue. The scheduled query recovers pending intents even after the source stream record expires. Historical failure metadata may keep its depth alarm active after recovery; remove only specifically reviewed diagnostic messages after recording the outcome.

## Processing DLQ redrive

OrdersDeadLetterQueue and NotificationDeadLetterQueue retain messages for fourteen days. Preserve a failing sample privately, identify and fix the cause, and verify the consumer with tests before moving messages. Missing orders, malformed messages and conflicting notification payloads will fail again without correction.

For an authorized redrive of the **orders** DLQ, get the two ARNs from stack outputs and limit the rate:

```bash
aws sqs start-message-move-task --source-arn "$ORDERS_DLQ_ARN" --destination-arn "$ORDERS_QUEUE_ARN" --max-number-of-messages-per-second 1 --region sa-east-1
aws sqs list-message-move-tasks --source-arn "$ORDERS_DLQ_ARN" --region sa-east-1
```

These commands mutate queues and require explicit operational authorization. They are instructions, not actions performed during this repository update. Monitor source/target depth, failures, final order state and fulfillment IDs. Do not delete/recreate orders or idempotency records to force a replay. NotificationQueue messages are EventBridge envelopes and belong in that notification queue, not the order queue.

## Notification failures

| Location                                    | Failed boundary                        | Recovery                                                                                            |
| ------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Pending `OrderProcessed` intent             | Application→EventBridge acknowledgment | Dispatcher/scheduled retry after dependency repair                                                  |
| EventDeliveryDeadLetterQueue                | EventBridge rule→NotificationsQueue    | Inspect target permissions and replay the reviewed event envelope                                   |
| NotificationDeadLetterQueue                 | Notification consumer transaction      | Fix payload/permission/state issue, then controlled redrive to NotificationsQueue                   |
| Pending `OrderNotificationRequested` intent | Application→SNS acknowledgment         | Dispatcher/scheduled retry                                                                          |
| NotificationDeliveryDeadLetterQueue         | SNS→audit SQS subscription             | Fix subscription/queue policy; replay only the reviewed notification using its original business ID |

Notification receipts have no TTL. A late duplicate `OrderProcessed` event with the same content is acknowledged without creating a new notification intent, even after published outbox rows expire. Different content for the same event ID is a conflict and remains visible through retries/DLQ.

SNS Standard can still deliver duplicate notifications following ambiguous publication or subscription retry. Consumers of the audit queue must deduplicate `OrderNotificationRequested:<orderId>` before non-idempotent external effects. No automatic republish of every published event is provided.

## Failed deployments

Inspect CloudFormation events and `scripts/inspect-deployment.py`. Record the attempted revision, Change Set ARN, deployment IDs, alarms and alias versions. `UPDATE_ROLLBACK_COMPLETE` means the stack update rolled back; it does not by itself prove a candidate received traffic or that a specific business fault was detected.

Do not start another change while a stack is in progress or rollback has failed. Resolve any failed rollback with an authorized operator, then plan a new Change Set. Retained data and externally delivered messages are not undone by code rollback. Keep event schemas additive and maintain readers that understand existing rows and envelopes. The IAM→Cognito migration needs its own compatibility plan.

## Cleanup

Cleanup destroys queues, logs and service configuration. Obtain authorization, stop producers, inspect pending/outstanding work, preserve required test evidence and confirm the exact account/region/stack first:

```bash
aws sts get-caller-identity
aws cloudformation list-stack-resources --stack-name orders-development --region sa-east-1
sam delete --stack-name orders-development --region sa-east-1
```

SAM asks for confirmation; do not add flags that bypass the review. Queue messages and unexported logs are deleted with their resources. Durable DynamoDB tables and the Cognito user pool use Retain and remain billable/managed outside the deleted stack until explicitly handled. Retention is intentional data protection, not full cleanup. Recreating a stack does not automatically re-adopt these retained resources.

The bootstrap artifact bucket and OIDC provider are also retained. Keep artifacts needed for rollback; its lifecycle expires old noncurrent versions after thirty days but does not delete all current artifacts. Delete the bootstrap only after application stacks no longer depend on its execution role or bucket. An account-wide OIDC provider may serve other repositories. Do not remove it as part of a casual lab cleanup.

Optional alarm KMS keys are scheduled for deletion when removed with the stack (seven-day waiting period); review encrypted data dependencies first. Inspect billing after cleanup for retained table storage/PITR, artifact storage and resources in other regions. This task did not execute AWS cleanup.
