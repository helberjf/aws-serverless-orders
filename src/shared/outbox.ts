import { randomUUID } from 'node:crypto';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { PublishCommand } from '@aws-sdk/client-sns';
import { z } from 'zod';
import { documentClient, eventBridgeClient, requiredEnv, snsClient, sqsClient } from './clients';
import { logError } from './http';

export const eventTypeSchema = z.enum(['OrderCreated', 'OrderProcessed', 'OrderNotificationRequested']);
export type EventType = z.infer<typeof eventTypeSchema>;
export function outboxItem(eventType: EventType, orderId: string, detail: Record<string, unknown>, createdAt: string) {
    return {
        eventId: `${eventType}:${orderId}`,
        eventType,
        orderId,
        detail,
        createdAt,
        nextAttemptAt: createdAt,
        deliveryStatus: 'PENDING',
    };
}
const outboxSchema = z.object({
    eventId: z.string().min(1),
    eventType: eventTypeSchema,
    orderId: z.uuid({ version: 'v4' }),
    detail: z.record(z.string(), z.unknown()),
    createdAt: z.iso.datetime(),
    nextAttemptAt: z.iso.datetime(),
    attempts: z.number().int().nonnegative().default(0),
    deliveryStatus: z.enum(['PENDING', 'PUBLISHED']),
});
export class OutboxBusyError extends Error {
    constructor() {
        super('Outbox record is leased by another worker');
    }
}
export async function dispatchOutbox(eventId: string): Promise<void> {
    const TableName = requiredEnv('OUTBOX_TABLE');
    const { Item } = await documentClient.send(new GetCommand({ TableName, Key: { eventId }, ConsistentRead: true }));
    if (!Item) throw new Error('Outbox record is missing');
    const record = outboxSchema.parse(Item);
    if (record.deliveryStatus === 'PUBLISHED') return;
    const now = Math.floor(Date.now() / 1000);
    if (Date.parse(record.nextAttemptAt) > Date.now()) throw new OutboxBusyError();
    const leaseOwner = randomUUID();
    try {
        await documentClient.send(
            new UpdateCommand({
                TableName,
                Key: { eventId },
                UpdateExpression:
                    'SET leaseOwner = :owner, leaseUntil = :until, nextAttemptAt = :next ADD attempts :one',
                ConditionExpression:
                    'deliveryStatus = :pending AND (attribute_not_exists(leaseUntil) OR leaseUntil <= :now)',
                ExpressionAttributeValues: {
                    ':owner': leaseOwner,
                    ':until': now + 120,
                    ':pending': 'PENDING',
                    ':now': now,
                    ':next': new Date((now + 120) * 1000).toISOString(),
                    ':one': 1,
                },
            }),
        );
    } catch (error) {
        if (error instanceof Error && error.name === 'ConditionalCheckFailedException') throw new OutboxBusyError();
        throw error;
    }
    try {
        const detail = { ...record.detail, eventId, orderId: record.orderId, schemaVersion: 1 };
        if (record.eventType === 'OrderCreated') {
            await sqsClient.send(
                new SendMessageCommand({
                    QueueUrl: requiredEnv('ORDERS_QUEUE_URL'),
                    MessageBody: JSON.stringify(detail),
                }),
            );
        } else if (record.eventType === 'OrderProcessed') {
            const result = await eventBridgeClient.send(
                new PutEventsCommand({
                    Entries: [
                        {
                            EventBusName: requiredEnv('ORDERS_EVENT_BUS'),
                            Source: 'com.helberjf.orders',
                            DetailType: 'OrderProcessed',
                            Detail: JSON.stringify(detail),
                            Time: new Date(record.createdAt),
                        },
                    ],
                }),
            );
            if (result.FailedEntryCount || !result.Entries?.[0]?.EventId)
                throw new Error('EventBridge rejected the event');
        } else {
            await snsClient.send(
                new PublishCommand({
                    TopicArn: requiredEnv('NOTIFICATIONS_TOPIC_ARN'),
                    Subject: 'Order ready for fulfillment',
                    Message: JSON.stringify(detail),
                    MessageAttributes: { eventId: { DataType: 'String', StringValue: eventId } },
                }),
            );
        }
        await documentClient.send(
            new UpdateCommand({
                TableName,
                Key: { eventId },
                UpdateExpression:
                    'SET deliveryStatus = :published, publishedAt = :at, expiresAt = :ttl REMOVE leaseOwner, leaseUntil',
                ConditionExpression: 'deliveryStatus = :pending AND leaseOwner = :owner',
                ExpressionAttributeValues: {
                    ':published': 'PUBLISHED',
                    ':pending': 'PENDING',
                    ':owner': leaseOwner,
                    ':at': new Date().toISOString(),
                    ':ttl': now + 7 * 86400,
                },
            }),
        );
        console.info({ eventType: 'outbox_delivered', orderId: record.orderId, eventId, status: 'PUBLISHED' });
    } catch (error) {
        // A publish can succeed before this update fails. Retrying is deliberate at-least-once delivery.
        try {
            const delay = Math.min(3600, 30 * 2 ** Math.min(record.attempts, 7));
            await documentClient.send(
                new UpdateCommand({
                    TableName,
                    Key: { eventId },
                    UpdateExpression: 'SET nextAttemptAt = :next REMOVE leaseOwner, leaseUntil',
                    ConditionExpression: 'leaseOwner = :owner',
                    ExpressionAttributeValues: {
                        ':owner': leaseOwner,
                        ':next': new Date((now + delay) * 1000).toISOString(),
                    },
                }),
            );
        } catch (releaseError) {
            logError('outbox_lease_release_failed', releaseError, { eventId });
        }
        throw error;
    }
}
