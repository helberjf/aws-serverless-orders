import { randomUUID } from 'node:crypto';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { documentClient, eventBridgeClient, snsClient, sqsClient } from '../../src/shared/clients';
import { lambdaHandler as create } from '../../src/create-order/app';
import { lambdaHandler as get } from '../../src/get-order/app';
import { lambdaHandler as process } from '../../src/process-order/app';
import { lambdaHandler as notify } from '../../src/notify-order/app';
import { dispatchOutbox } from '../../src/shared/outbox';
import { apiEvent, input, sqsEvent } from '../support';

const endpoint = processEnvEndpoint();
function processEnvEndpoint(): string {
    const endpoint = globalThis.process.env.DYNAMODB_ENDPOINT!;
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname))
        throw new Error('Integration tests require a loopback DynamoDB Local endpoint');
    return endpoint;
}
const client = new DynamoDBClient({ endpoint });
const prefix = `aso-test-${randomUUID().slice(0, 8)}`;
const tables = [
    ['ORDERS_TABLE', 'orderId'],
    ['IDEMPOTENCY_TABLE', 'idempotencyKey'],
    ['OUTBOX_TABLE', 'eventId'],
    ['FULFILLMENTS_TABLE', 'orderId'],
    ['NOTIFICATION_RECEIPTS_TABLE', 'eventId'],
] as const;
const created: string[] = [];
beforeAll(async () => {
    for (const [env, key] of tables) {
        const TableName = `${prefix}-${env.toLowerCase()}`;
        globalThis.process.env[env] = TableName;
        await client.send(
            new CreateTableCommand({
                TableName,
                BillingMode: 'PAY_PER_REQUEST',
                KeySchema: [{ AttributeName: key, KeyType: 'HASH' }],
                AttributeDefinitions: [{ AttributeName: key, AttributeType: 'S' }],
            }),
        );
        created.push(TableName);
    }
});
afterAll(async () => {
    // Only tables this suite created on the guarded loopback endpoint are removed.
    for (const TableName of created) await client.send(new DeleteTableCommand({ TableName }));
    client.destroy();
    documentClient.destroy();
});
beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
function request(key: string = randomUUID()) {
    const event = apiEvent();
    event.headers = { 'Idempotency-Key': key };
    return event;
}
function lookup(orderId: string) {
    return { ...apiEvent(null), pathParameters: { orderId } };
}
async function row(env: string, Key: Record<string, string>) {
    return (
        await documentClient.send(new GetCommand({ TableName: globalThis.process.env[env], Key, ConsistentRead: true }))
    ).Item;
}

describe('DynamoDB Local transactions across real handlers', () => {
    it('creates, publishes, prepares fulfillment and returns the updated status', async () => {
        const result = await create(request());
        expect(result.statusCode).toBe(201);
        const order = JSON.parse(result.body);
        const send = vi.spyOn(sqsClient, 'send').mockResolvedValue({ MessageId: 'transport-double' } as never);
        await dispatchOutbox(`OrderCreated:${order.orderId}`);
        const body = String((send.mock.calls[0][0] as SendMessageCommand).input.MessageBody);
        expect(await process(sqsEvent(body))).toEqual({ batchItemFailures: [] });
        const queried = await get(lookup(order.orderId));
        expect(queried.statusCode).toBe(200);
        expect(JSON.parse(queried.body)).toMatchObject({
            status: 'PROCESSED',
            fulfillmentId: `fulfillment:${order.orderId}`,
        });
        expect(await row('FULFILLMENTS_TABLE', { orderId: order.orderId })).toMatchObject({
            quantity: 2,
            status: 'READY_FOR_FULFILLMENT',
        });
        const publish = vi
            .spyOn(eventBridgeClient, 'send')
            .mockResolvedValue({ FailedEntryCount: 0, Entries: [{ EventId: 'accepted' }] } as never);
        await dispatchOutbox(`OrderProcessed:${order.orderId}`);
        expect(publish).toHaveBeenCalledTimes(1);
        const published = (publish.mock.calls[0][0] as PutEventsCommand).input.Entries![0];
        const notification = JSON.stringify({
            source: published.Source,
            'detail-type': published.DetailType,
            detail: JSON.parse(published.Detail!),
        });
        expect(await notify(sqsEvent(notification, notification))).toEqual({ batchItemFailures: [] });
        const sns = vi.spyOn(snsClient, 'send').mockResolvedValue({ MessageId: 'notification-accepted' } as never);
        await dispatchOutbox(`OrderNotificationRequested:${order.orderId}`);
        await notify(sqsEvent(notification));
        await dispatchOutbox(`OrderNotificationRequested:${order.orderId}`);
        expect(sns).toHaveBeenCalledTimes(1);
        const before = await get(lookup(order.orderId));
        await process(sqsEvent(body, body));
        expect((await get(lookup(order.orderId))).body).toBe(before.body);
    });
    it('deduplicates simultaneous HTTP requests with the same owner and key', async () => {
        const event = request();
        const results = await Promise.all(Array.from({ length: 8 }, () => create(event)));
        expect(results.every((r) => [201, 409].includes(r.statusCode))).toBe(true);
        const orders = results.filter((r) => r.statusCode === 201).map((r) => JSON.parse(r.body).orderId);
        expect(new Set(orders).size).toBe(1);
        expect(JSON.parse((await create(event)).body).orderId).toBe(orders[0]);
    });
    it('isolates keys by owner, rejects changed payloads and hides other owners', async () => {
        const event = request();
        const first = JSON.parse((await create(event)).body);
        expect((await create({ ...event, body: JSON.stringify({ ...input, quantity: 3 }) })).statusCode).toBe(409);
        const other = request(String(event.headers['Idempotency-Key']));
        other.requestContext.authorizer!.claims.sub = 'user-b';
        const second = JSON.parse((await create(other)).body);
        expect(second.orderId).not.toBe(first.orderId);
        expect((await get({ ...other, pathParameters: { orderId: first.orderId } })).statusCode).toBe(404);
    });
    it('makes concurrent delivery commit one fulfillment and one business event', async () => {
        const order = JSON.parse((await create(request())).body);
        const message = JSON.stringify({ orderId: order.orderId });
        const results = await Promise.all(Array.from({ length: 5 }, () => process(sqsEvent(message))));
        // A transient transaction conflict may be retried; only the atomic winner changes the order.
        for (const result of results)
            if (result.batchItemFailures.length)
                expect(await process(sqsEvent(message))).toEqual({ batchItemFailures: [] });
        const ticket = await row('FULFILLMENTS_TABLE', { orderId: order.orderId });
        expect(ticket?.fulfillmentId).toBe(`fulfillment:${order.orderId}`);
        expect(await row('OUTBOX_TABLE', { eventId: `OrderProcessed:${order.orderId}` })).toMatchObject({
            deliveryStatus: 'PENDING',
        });
    });
    it('does not partially commit a failed fulfillment transaction', async () => {
        const order = JSON.parse((await create(request())).body);
        await documentClient.send(
            new UpdateCommand({
                TableName: globalThis.process.env.FULFILLMENTS_TABLE,
                Key: { orderId: order.orderId },
                UpdateExpression: 'SET marker = :marker',
                ExpressionAttributeValues: { ':marker': 'existing-ticket-conflict' },
            }),
        );
        expect((await process(sqsEvent(JSON.stringify({ orderId: order.orderId })))).batchItemFailures).toHaveLength(1);
        expect(await row('ORDERS_TABLE', { orderId: order.orderId })).toMatchObject({ status: 'RECEIVED' });
        expect(await row('OUTBOX_TABLE', { eventId: `OrderProcessed:${order.orderId}` })).toBeUndefined();
    });
    it('returns only poison-message IDs from mixed batches and preserves successful timestamps on replay', async () => {
        const order = JSON.parse((await create(request())).body);
        const message = JSON.stringify({ orderId: order.orderId });
        expect(await process(sqsEvent(message, '{bad', JSON.stringify({ orderId: randomUUID() })))).toEqual({
            batchItemFailures: [{ itemIdentifier: 'message-1' }, { itemIdentifier: 'message-2' }],
        });
        const completed = await get(lookup(order.orderId));
        expect(await process(sqsEvent(message))).toEqual({ batchItemFailures: [] });
        expect((await get(lookup(order.orderId))).body).toBe(completed.body);
    });
});
