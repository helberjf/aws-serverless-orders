import type { DynamoDBBatchResponse, DynamoDBStreamEvent } from 'aws-lambda';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { requiredEnv, sqsClient } from '../shared/clients';
import { logError } from '../shared/http';
import { isOrderId } from '../shared/order';

export const lambdaHandler = async (event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> => {
    for (const record of event.Records) {
        // Updates made by the consumer must never enqueue another order.
        if (record.eventName !== 'INSERT') continue;
        const sequenceNumber = record.dynamodb?.SequenceNumber;
        try {
            const orderId = record.dynamodb?.Keys?.orderId?.S;
            if (!isOrderId(orderId)) throw new Error('Invalid order ID in stream record');
            await sqsClient.send(
                new SendMessageCommand({
                    QueueUrl: requiredEnv('ORDERS_QUEUE_URL'),
                    MessageBody: JSON.stringify({ orderId }),
                }),
            );
        } catch (error) {
            logError('publish_order_failed', error, { eventId: record.eventID, sequenceNumber });
            // Streams checkpoint at the first failure. Do not publish the rest of the batch yet.
            if (!sequenceNumber) throw error;
            return { batchItemFailures: [{ itemIdentifier: sequenceNumber }] };
        }
    }
    return { batchItemFailures: [] };
};
