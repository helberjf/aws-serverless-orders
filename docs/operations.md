# Operations and failure recovery

Use the stack outputs to find resource names and URLs:

```bash
aws cloudformation describe-stacks --stack-name aws-serverless-orders --region sa-east-1 \
  --query 'Stacks[0].Outputs' --output table
```

The examples below use Bash. Set `TABLE`, `QUEUE_URL`, `DLQ_ARN`, and `PUBLISH_FAILURES_URL` from the corresponding outputs. These commands require an operator role with access to those specific resources.

## Observe

```bash
aws logs tail /aws/lambda/aws-serverless-orders/process-order --region sa-east-1 --since 1h --follow
```

Replace `process-order` with `create-order`, `get-order`, or `publish-order` to inspect another handler. Log records contain event names, message/order identifiers, and error types; request bodies are not logged. Logs are retained for 14 days. Lambda tracing and API Gateway tracing are enabled; this does not instrument every AWS SDK call as a separate trace segment.

CloudWatch alarms track processing DLQ depth, publisher failure queue depth, and orders older than five minutes in the source queue. Configure alarm actions (for example an SNS subscription) in your own environment: the template creates alarms but does not send email or page anyone. Also monitor Lambda errors/throttles and the publisher's `IteratorAge`, especially during an incident.

## Failed processing messages

`OrdersDeadLetterQueue` contains original order messages after five unsuccessful receives. Both malformed messages and persistent service errors can arrive here. Inspect the message and the `process_order_failed` log first. A failure does not change the order to a terminal `FAILED` state; its status remains `RECEIVED` until successful processing.

After fixing the cause, redrive valid messages with SQS's console or CLI:

```bash
aws sqs start-message-move-task --source-arn "$DLQ_ARN" --region sa-east-1
```

Malformed messages cannot be repaired by retrying unchanged. Correct their payload or remove them only after recording why they are invalid. Reprocessing an already `PROCESSED` order is acknowledged without changing `processedAt`. A nonexistent order is retried, never created by the processor.

## Failed publishing and reconciliation

The DynamoDB stream publisher retries failed records up to 10 times or a record age of one hour, whichever is reached first. The underlying DynamoDB stream retains records for 24 hours. The SQS destination `PublishFailuresQueue` stores **failure metadata**, not complete order messages. Do not redrive that queue into `OrdersQueue`.

1. Inspect the publisher logs, failure metadata, IAM permissions, throttling, and SQS availability.
2. Restore publishing, then identify older `RECEIVED` orders in the table. This paginated scan is suitable for this small demo, not a high-volume production reconciliation job.
3. Check an individual order and enqueue its ID to recover it. A race with the normal publisher is harmless for the current atomic consumer operation.
4. Verify `PROCESSED` with the API or a strongly consistent DynamoDB read. Remove failure metadata only after reconciliation.

```bash
aws sqs receive-message --queue-url "$PUBLISH_FAILURES_URL" --region sa-east-1

aws dynamodb scan --table-name "$TABLE" --region sa-east-1 --consistent-read \
  --filter-expression '#s = :received' \
  --expression-attribute-names '{"#s":"status"}' \
  --expression-attribute-values '{":received":{"S":"RECEIVED"}}' \
  --projection-expression 'orderId, createdAt, #s'

# Replace the example UUID with the verified pending order ID.
aws sqs send-message --queue-url "$QUEUE_URL" --region sa-east-1 \
  --message-body '{"orderId":"d73b82b5-bcf4-4aae-a3b3-0e726019f8e0"}'
```

Do not assume that an empty failure queue proves there are no pending orders. Destination delivery can fail, streams expire, and disabling the event mapping for too long loses the stream history. The durable order table is the source for reconciliation. For a larger system, add a pending-status index, automated reconciliation, and alerts for failed destination delivery.

## Upgrade from the original create-order application

- Install dependencies at the repository root with `npm ci`; the nested `src/create-order/package.json` has been consolidated into one lockfile.
- `POST /orders` still returns `201` and a `RECEIVED` order. Publishing now happens asynchronously from committed DynamoDB inserts. A successful response means the order is persisted, not yet processed.
- API requests now require AWS Signature Version 4 and `execute-api:Invoke`. Update callers before deploying the API change.
- The existing `OrdersTable`, `OrdersQueue`, `CreateOrderFunction`, and implicit API logical IDs are preserved. Inspect the CloudFormation change set before accepting it.
- Records created before Streams were enabled are not automatically replayed. Review old `RECEIVED` orders using the reconciliation procedure above.
- New managed log groups use `/aws/lambda/<stack-name>/<handler-name>`. Older automatically created log groups may still exist; review them before deleting them.

## Cleanup

```bash
sam delete --stack-name aws-serverless-orders --region sa-east-1
```

The orders table is intentionally retained, including on replacement. Save its physical name before deleting the stack; retained tables and backups can continue to incur costs. Delete retained data separately only when it is no longer needed. Stack deletion removes the queues and their remaining messages, so inspect or recover pending work first.
