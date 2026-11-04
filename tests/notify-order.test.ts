import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { lambdaHandler, processedEventSchema } from '../src/notify-order/app';
import { lambdaHandler as health } from '../src/health/app';
import { sha256 } from '../src/shared/idempotency';
import { apiEvent, mockClients, orderId, sqsEvent, failure } from './support';

export const envelope = {
    source: 'com.helberjf.orders',
    'detail-type': 'OrderProcessed',
    detail: {
        schemaVersion: 1,
        eventId: `OrderProcessed:${orderId}`,
        orderId,
        fulfillmentId: `fulfillment:${orderId}`,
        quantity: 2,
        processedAt: '2026-01-01T00:00:00.000Z',
    },
};
describe('notification transaction', () => {
    let clients: ReturnType<typeof mockClients>;
    beforeEach(() => {
        clients = mockClients();
    });
    it('atomically deduplicates the business event and schedules SNS delivery', async () => {
        expect(await lambdaHandler(sqsEvent(JSON.stringify(envelope)))).toEqual({ batchItemFailures: [] });
        const transaction = clients.dynamo.mock.calls[0][0] as TransactWriteCommand;
        expect(transaction.input.TransactItems).toHaveLength(2);
        expect(transaction.input.TransactItems![1].Put?.Item).toMatchObject({
            eventType: 'OrderNotificationRequested',
            deliveryStatus: 'PENDING',
        });
        expect(clients.sns).not.toHaveBeenCalled();
    });
    it('acknowledges a duplicate after a committed matching transaction', async () => {
        clients.dynamo.mockRejectedValueOnce(failure()).mockResolvedValueOnce({
            Item: { requestHash: sha256(JSON.stringify(processedEventSchema.parse(envelope).detail)) },
        });
        expect(await lambdaHandler(sqsEvent(JSON.stringify(envelope)))).toEqual({ batchItemFailures: [] });
    });
    it.each([{}, { Item: { requestHash: 'conflicting-event' } }])(
        'does not acknowledge an uncommitted or conflicting receipt',
        async (result) => {
            clients.dynamo.mockRejectedValueOnce(failure()).mockResolvedValueOnce(result);
            expect((await lambdaHandler(sqsEvent(JSON.stringify(envelope)))).batchItemFailures).toHaveLength(1);
        },
    );
    it.each([
        '{',
        'null',
        JSON.stringify({ ...envelope, source: 'untrusted' }),
        JSON.stringify({ ...envelope, detail: { ...envelope.detail, eventId: 'wrong' } }),
    ])('retries invalid envelopes %s', async (body) => {
        expect((await lambdaHandler(sqsEvent(body))).batchItemFailures).toHaveLength(1);
        expect(clients.dynamo).not.toHaveBeenCalled();
    });
    it('continues after an invalid record in a mixed batch', async () => {
        expect(await lambdaHandler(sqsEvent('{', JSON.stringify(envelope)))).toEqual({
            batchItemFailures: [{ itemIdentifier: 'message-0' }],
        });
        expect(clients.dynamo).toHaveBeenCalledTimes(1);
    });
    it('supports public health checks without AWS calls', async () => {
        const event = apiEvent(null);
        event.requestContext.authorizer = null;
        expect(JSON.parse((await health(event)).body)).toEqual({ status: 'ok', service: 'aws-serverless-orders' });
        expect(clients.dynamo).not.toHaveBeenCalled();
    });
});
