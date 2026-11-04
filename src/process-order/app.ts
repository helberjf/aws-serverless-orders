import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { documentClient, requiredEnv } from '../shared/clients';
import { logError } from '../shared/http';
import { isObject, isOrderId } from '../shared/order';

async function processOrder(orderId: string): Promise<void> {
    const TableName = requiredEnv('ORDERS_TABLE');
    try {
        // This demo's business operation is the atomic RECEIVED -> PROCESSED transition.
        await documentClient.send(
            new UpdateCommand({
                TableName,
                Key: { orderId },
                UpdateExpression: 'SET #status = :processed, processedAt = :processedAt',
                ConditionExpression: 'attribute_exists(orderId) AND #status = :received',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: {
                    ':received': 'RECEIVED',
                    ':processed': 'PROCESSED',
                    ':processedAt': new Date().toISOString(),
                },
            }),
        );
        console.info({ event: 'order_processed', orderId });
    } catch (error) {
        if (!(error instanceof Error) || error.name !== 'ConditionalCheckFailedException') throw error;
        const { Item } = await documentClient.send(
            new GetCommand({ TableName, Key: { orderId }, ConsistentRead: true }),
        );
        // Only a confirmed completed order is a successful duplicate; missing orders must retry.
        if (Item?.status !== 'PROCESSED') throw error;
        console.info({ event: 'order_already_processed', orderId });
    }
}

export const lambdaHandler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
    const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
    for (const record of event.Records) {
        try {
            const body: unknown = JSON.parse(record.body);
            if (!isObject(body) || !isOrderId(body.orderId)) throw new Error('Message must contain a UUID v4 orderId');
            await processOrder(body.orderId);
        } catch (error) {
            logError('process_order_failed', error, { messageId: record.messageId });
            batchItemFailures.push({ itemIdentifier: record.messageId });
        }
    }
    return { batchItemFailures };
};
