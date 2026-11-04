import { instrument } from '../shared/telemetry';
import { logInfo } from '../shared/telemetry';
import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { documentClient, requiredEnv } from '../shared/clients';
import { logError } from '../shared/http';
import { orderSchema, processingMessageSchema } from '../shared/order';
import { outboxItem } from '../shared/outbox';

export async function processOrder(orderId: string): Promise<void> {
    const TableName = requiredEnv('ORDERS_TABLE');
    const read = () => documentClient.send(new GetCommand({ TableName, Key: { orderId }, ConsistentRead: true }));
    const { Item } = await read();
    if (!Item) throw new Error('Order does not exist');
    if (Item.status === 'PROCESSED') return;
    const order = orderSchema.parse(Item);
    const processedAt = new Date().toISOString();
    const fulfillmentId = `fulfillment:${orderId}`;
    try {
        await documentClient.send(
            new TransactWriteCommand({
                TransactItems: [
                    {
                        Update: {
                            TableName,
                            Key: { orderId },
                            UpdateExpression:
                                'SET #status = :processed, processedAt = :at, updatedAt = :at, fulfillmentId = :fulfillment',
                            ConditionExpression:
                                'attribute_exists(orderId) AND #status = :received AND updatedAt = :version',
                            ExpressionAttributeNames: { '#status': 'status' },
                            ExpressionAttributeValues: {
                                ':processed': 'PROCESSED',
                                ':received': 'RECEIVED',
                                ':at': processedAt,
                                ':fulfillment': fulfillmentId,
                                ':version': order.updatedAt,
                            },
                        },
                    },
                    {
                        Put: {
                            TableName: requiredEnv('FULFILLMENTS_TABLE'),
                            Item: {
                                orderId,
                                fulfillmentId,
                                productId: order.productId,
                                quantity: order.quantity,
                                status: 'READY_FOR_FULFILLMENT',
                                createdAt: processedAt,
                            },
                            ConditionExpression: 'attribute_not_exists(orderId)',
                        },
                    },
                    {
                        Put: {
                            TableName: requiredEnv('OUTBOX_TABLE'),
                            Item: outboxItem(
                                'OrderProcessed',
                                orderId,
                                { fulfillmentId, quantity: order.quantity, processedAt },
                                processedAt,
                            ),
                            ConditionExpression: 'attribute_not_exists(eventId)',
                        },
                    },
                ],
            }),
        );
    } catch (error) {
        const latest = await read();
        if (latest.Item?.status === 'PROCESSED') return;
        throw error;
    }
    logInfo({ eventType: 'order_processed', orderId, status: 'PROCESSED', fulfillmentId });
}
export const lambdaHandler = instrument('process-order', async (event: SQSEvent): Promise<SQSBatchResponse> => {
    const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
    for (const record of event.Records) {
        const started = Date.now();
        try {
            const body = processingMessageSchema.parse(JSON.parse(record.body));
            await processOrder(body.orderId);
            logInfo({
                eventType: 'order_message_handled',
                orderId: body.orderId,
                messageId: record.messageId,
                durationMs: Date.now() - started,
            });
        } catch (error) {
            logError('process_order_failed', error, { messageId: record.messageId, durationMs: Date.now() - started });
            batchItemFailures.push({ itemIdentifier: record.messageId });
        }
    }
    return { batchItemFailures };
});
