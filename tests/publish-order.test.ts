import { lambdaHandler } from '../src/publish-order/app';
import { dispatchOutbox, outboxItem } from '../src/shared/outbox';
import { mockClients, orderId, streamEvent, streamRecord, failure } from './support';
describe('durable outbox delivery', () => {
    let clients: ReturnType<typeof mockClients>;
    const record = () =>
        outboxItem('OrderCreated', orderId, { requestId: 'request-1' }, new Date(Date.now() - 1000).toISOString());
    beforeEach(() => {
        clients = mockClients();
        clients.dynamo.mockResolvedValueOnce({ Item: record() });
    });
    it('sends to SQS under a lease and marks delivered only after acceptance', async () => {
        expect(await lambdaHandler(streamEvent(streamRecord()))).toEqual({ batchItemFailures: [] });
        expect(JSON.parse(String(clients.sqs.mock.calls[0][0].input.MessageBody))).toMatchObject({
            orderId,
            eventId: `OrderCreated:${orderId}`,
            schemaVersion: 1,
        });
        expect(clients.dynamo.mock.calls[1][0].input.ConditionExpression).toContain('leaseUntil');
        expect(clients.dynamo.mock.calls[2][0].input.ExpressionAttributeValues).toMatchObject({
            ':published': 'PUBLISHED',
        });
    });
    it('ignores stream updates and deletions', async () => {
        expect(await lambdaHandler(streamEvent(streamRecord('1', 'MODIFY'), streamRecord('2', 'REMOVE')))).toEqual({
            batchItemFailures: [],
        });
        expect(clients.dynamo).not.toHaveBeenCalled();
    });
    it('retries the first failed sequence and does not publish subsequent records', async () => {
        clients.sqs.mockRejectedValue(failure());
        expect(await lambdaHandler(streamEvent(streamRecord('1'), streamRecord('2')))).toEqual({
            batchItemFailures: [{ itemIdentifier: '1' }],
        });
        expect(clients.sqs).toHaveBeenCalledTimes(1);
        expect(clients.dynamo.mock.calls.at(-1)![0].input.UpdateExpression).toContain('nextAttemptAt');
    });
    it('rejects records lacking retry metadata', async () => {
        await expect(lambdaHandler(streamEvent({ eventName: 'INSERT' }))).rejects.toThrow('Missing outbox');
    });
    it('reports malformed records using their sequence number', async () => {
        expect(await lambdaHandler(streamEvent({ eventName: 'INSERT', dynamodb: { SequenceNumber: '2' } }))).toEqual({
            batchItemFailures: [{ itemIdentifier: '2' }],
        });
    });
    it('does not republish completed intents', async () => {
        clients.dynamo.mockReset().mockResolvedValue({ Item: { ...record(), deliveryStatus: 'PUBLISHED' } });
        await dispatchOutbox('event');
        expect(clients.sqs).not.toHaveBeenCalled();
    });
    it('does not steal an active lease', async () => {
        clients.dynamo.mockRejectedValueOnce(failure());
        await expect(dispatchOutbox('event')).rejects.toThrow('leased');
        expect(clients.sqs).not.toHaveBeenCalled();
    });
    it('defers attempts still in backoff', async () => {
        clients.dynamo
            .mockReset()
            .mockResolvedValue({ Item: { ...record(), nextAttemptAt: new Date(Date.now() + 60000).toISOString() } });
        await expect(dispatchOutbox('event')).rejects.toThrow('leased');
        expect(clients.sqs).not.toHaveBeenCalled();
    });
    it('retains pending work if the delivered marker fails after a successful send', async () => {
        clients.dynamo.mockResolvedValueOnce({}).mockRejectedValueOnce(failure('TimeoutError'));
        await expect(dispatchOutbox('event')).rejects.toThrow();
        expect(clients.sqs).toHaveBeenCalledTimes(1);
        expect(clients.dynamo.mock.calls.at(-1)![0].input.UpdateExpression).not.toContain('expiresAt');
    });
    it('preserves the publication failure if releasing the lease also fails', async () => {
        clients.sqs.mockRejectedValue(failure('PublishError'));
        clients.dynamo.mockResolvedValueOnce({}).mockRejectedValueOnce(failure());
        await expect(dispatchOutbox('event')).rejects.toMatchObject({ name: 'PublishError' });
    });
    it('publishes business events and checks each EventBridge result', async () => {
        clients.dynamo
            .mockReset()
            .mockResolvedValueOnce({ Item: { ...record(), eventType: 'OrderProcessed' } })
            .mockResolvedValue({});
        await dispatchOutbox('event');
        expect(clients.events.mock.calls[0][0].input.Entries).toMatchObject([
            { Source: 'com.helberjf.orders', DetailType: 'OrderProcessed' },
        ]);
    });
    it.each([{ FailedEntryCount: 1, Entries: [{ ErrorCode: 'InternalFailure' }] }, {}])(
        'does not mark a failed EventBridge event delivered',
        async (result) => {
            clients.dynamo
                .mockReset()
                .mockResolvedValueOnce({ Item: { ...record(), eventType: 'OrderProcessed' } })
                .mockResolvedValue({});
            clients.events.mockResolvedValue(result);
            await expect(dispatchOutbox('event')).rejects.toThrow('EventBridge rejected');
        },
    );
    it('publishes notification intents with a stable business event identifier', async () => {
        clients.dynamo
            .mockReset()
            .mockResolvedValueOnce({ Item: { ...record(), eventType: 'OrderNotificationRequested' } })
            .mockResolvedValue({});
        await dispatchOutbox('event');
        expect(clients.sns.mock.calls[0][0].input.MessageAttributes).toMatchObject({
            eventId: { StringValue: 'event' },
        });
    });
    it('rejects a missing outbox item', async () => {
        clients.dynamo.mockReset().mockResolvedValue({});
        await expect(dispatchOutbox('event')).rejects.toThrow('missing');
    });
    it('retries storage errors when acquiring a lease', async () => {
        clients.dynamo.mockRejectedValueOnce(failure('ThrottlingException'));
        await expect(dispatchOutbox('event')).rejects.toMatchObject({ name: 'ThrottlingException' });
    });
});
