# Event examples

These files are illustrative fixtures, not captured production data. IDs, the account number and timestamps are examples.

| File                   | Meaning                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `health.json`          | Public API Gateway liveness event; safe to invoke locally without a database                               |
| `event.json`           | POST body without authorizer claims; expected to return **401** under the current Cognito contract         |
| `dynamodb-order.json`  | Outbox-table INSERT with an `eventId` key and stream sequence number; the referenced outbox row must exist |
| `sqs-order.json`       | Minimal legacy-compatible processing message `{orderId}` inside an SQS batch                               |
| `order-processed.json` | EventBridge envelope delivered as the SQS notification message body                                        |

```bash
sam build
sam local invoke HealthFunction --event events/health.json
```

The other fixtures require their dependent table rows/environment configuration and are not a self-contained local AWS emulator. Use the DynamoDB Local integration suite for a seeded, isolated application flow. API Gateway verifies real JWT signatures in AWS; adding fake authorizer claims to a local event is only a trusted test fixture, not a valid Cognito login. Live API examples use the PKCE helper.

The EventBridge envelope's transport `id` can change on retry. Deduplication uses `detail.eventId`. SNS's raw audit message contains `eventId: OrderNotificationRequested:<orderId>`, `sourceEventId: OrderProcessed:<orderId>`, schema version, order/fulfillment IDs, quantity, processed timestamp and `READY_FOR_FULFILLMENT` status. It excludes customer identity and tokens.
