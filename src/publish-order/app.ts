import type { DynamoDBBatchResponse, DynamoDBStreamEvent } from 'aws-lambda';
import { dispatchOutbox } from '../shared/outbox';
import { logError } from '../shared/http';

export const lambdaHandler = async (event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> => {
    for (const record of event.Records) {
        if (record.eventName !== 'INSERT') continue;
        const sequenceNumber = record.dynamodb?.SequenceNumber;
        try {
            const eventId = record.dynamodb?.Keys?.eventId?.S;
            if (!eventId) throw new Error('Missing outbox event ID');
            await dispatchOutbox(eventId);
        } catch (error) {
            logError('publish_order_failed', error, { eventId: record.eventID, sequenceNumber });
            if (!sequenceNumber) throw error;
            return { batchItemFailures: [{ itemIdentifier: sequenceNumber }] };
        }
    }
    return { batchItemFailures: [] };
};
