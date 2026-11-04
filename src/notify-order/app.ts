import type { SQSEvent, SQSBatchResponse } from 'aws-lambda';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { documentClient, requiredEnv } from '../shared/clients';
import { logError } from '../shared/http';
import { sha256 } from '../shared/idempotency';
import { outboxItem } from '../shared/outbox';

export const processedEventSchema = z.object({
    source: z.literal('com.helberjf.orders'),
    'detail-type': z.literal('OrderProcessed'),
    detail: z
        .object({
            schemaVersion: z.literal(1),
            eventId: z.string(),
            orderId: z.uuid({ version: 'v4' }),
            fulfillmentId: z.string(),
            quantity: z.number().int().min(1).max(1000),
            processedAt: z.iso.datetime(),
        })
        .refine((d) => d.eventId === `OrderProcessed:${d.orderId}` && d.fulfillmentId === `fulfillment:${d.orderId}`),
});

async function queueNotification(body: string): Promise<void> {
    const { detail } = processedEventSchema.parse(JSON.parse(body));
    const eventId = detail.eventId;
    const requestHash = sha256(JSON.stringify(detail));
    const TableName = requiredEnv('NOTIFICATION_RECEIPTS_TABLE');
    const createdAt = new Date().toISOString();
    try {
        await documentClient.send(
            new TransactWriteCommand({
                TransactItems: [
                    {
                        Put: {
                            TableName,
                            Item: { eventId, requestHash, createdAt },
                            ConditionExpression: 'attribute_not_exists(eventId)',
                        },
                    },
                    {
                        Put: {
                            TableName: requiredEnv('OUTBOX_TABLE'),
                            Item: outboxItem(
                                'OrderNotificationRequested',
                                detail.orderId,
                                {
                                    sourceEventId: eventId,
                                    fulfillmentId: detail.fulfillmentId,
                                    quantity: detail.quantity,
                                    processedAt: detail.processedAt,
                                    status: 'READY_FOR_FULFILLMENT',
                                },
                                createdAt,
                            ),
                            ConditionExpression: 'attribute_not_exists(eventId)',
                        },
                    },
                ],
            }),
        );
    } catch (error) {
        const { Item } = await documentClient.send(
            new GetCommand({ TableName, Key: { eventId }, ConsistentRead: true }),
        );
        if (Item?.requestHash === requestHash) return;
        throw error;
    }
    console.info({ eventType: 'order_notification_queued', eventId, orderId: detail.orderId });
}

export const lambdaHandler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
    const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
    for (const record of event.Records) {
        try {
            await queueNotification(record.body);
        } catch (error) {
            logError('order_notification_failed', error, { messageId: record.messageId });
            batchItemFailures.push({ itemIdentifier: record.messageId });
        }
    }
    return { batchItemFailures };
};
