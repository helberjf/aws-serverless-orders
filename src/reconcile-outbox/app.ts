import { instrument } from '../shared/telemetry';
import { logInfo } from '../shared/telemetry';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { documentClient, requiredEnv } from '../shared/clients';
import { dispatchOutbox } from '../shared/outbox';
import { logError } from '../shared/http';

export const lambdaHandler = instrument(
    'reconcile-outbox',
    async (): Promise<{ attempted: number; failed: number }> => {
        const cutoff = new Date().toISOString();
        let lastKey: Record<string, unknown> | undefined;
        let attempted = 0;
        let failed = 0;
        // Bound execution time/cost. The next scheduled invocation continues draining pending work.
        for (let page = 0; page < 2; page++) {
            const result = await documentClient.send(
                new QueryCommand({
                    TableName: requiredEnv('OUTBOX_TABLE'),
                    IndexName: 'PendingByNextAttempt',
                    KeyConditionExpression: 'deliveryStatus = :pending AND nextAttemptAt <= :cutoff',
                    ExpressionAttributeValues: { ':pending': 'PENDING', ':cutoff': cutoff },
                    Limit: 20,
                    ExclusiveStartKey: lastKey,
                }),
            );
            await Promise.all(
                (result.Items ?? []).map(async (item) => {
                    attempted++;
                    try {
                        await dispatchOutbox(String(item.eventId));
                    } catch (error) {
                        failed++;
                        logError('outbox_reconciliation_failed', error, { eventId: item.eventId });
                    }
                }),
            );
            lastKey = result.LastEvaluatedKey;
            if (!lastKey) break;
        }
        logInfo({ eventType: 'outbox_reconciled', attempted, failed });
        return { attempted, failed };
    },
);
