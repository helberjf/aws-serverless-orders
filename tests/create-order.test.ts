import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { lambdaHandler } from '../src/create-order/app';
import { apiEvent, input, mockClients } from './support';

describe('POST /orders', () => {
    let clients: ReturnType<typeof mockClients>;
    beforeEach(() => {
        clients = mockClients();
    });

    it('persists a validated order without a direct SQS dual write', async () => {
        const response = await lambdaHandler(apiEvent());
        const order = JSON.parse(response.body);
        expect(response.statusCode).toBe(201);
        expect(response.headers).toMatchObject({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        expect(order).toMatchObject({
            ...input,
            status: 'RECEIVED',
            orderId: expect.any(String),
            createdAt: expect.any(String),
        });
        expect(clients.dynamo).toHaveBeenCalledTimes(1);
        const command = clients.dynamo.mock.calls[0][0];
        expect(command).toBeInstanceOf(PutCommand);
        expect(command.input).toEqual({
            TableName: 'test-orders',
            Item: order,
            ConditionExpression: 'attribute_not_exists(orderId)',
        });
        expect(clients.sqs).not.toHaveBeenCalled();
    });

    it('decodes API Gateway base64 bodies and normalizes identifiers', async () => {
        const event = apiEvent(
            Buffer.from(JSON.stringify({ ...input, customerId: '  c1  ', productId: ' p1 ' })).toString('base64'),
        );
        event.isBase64Encoded = true;
        expect(JSON.parse((await lambdaHandler(event)).body)).toMatchObject({ customerId: 'c1', productId: 'p1' });
    });

    it.each([null, '', '{bad-json', 'null', '[]', 'true', '1', '"text"'])(
        'rejects an invalid body %s without writes',
        async (body) => {
            expect((await lambdaHandler(apiEvent(body))).statusCode).toBe(400);
            expect(clients.dynamo).not.toHaveBeenCalled();
        },
    );

    it.each([
        {},
        { ...input, customerId: null },
        { ...input, customerId: 1 },
        { ...input, customerId: ' ' },
        { ...input, customerId: 'a'.repeat(129) },
        { ...input, productId: null },
        { ...input, productId: '' },
        { ...input, productId: 'a'.repeat(129) },
        { ...input, quantity: '2' },
        { ...input, quantity: 0 },
        { ...input, quantity: -1 },
        { ...input, quantity: 1.5 },
        { ...input, quantity: 1001 },
    ])('rejects invalid order fields: %j', async (body) => {
        expect((await lambdaHandler(apiEvent(JSON.stringify(body)))).statusCode).toBe(400);
        expect(clients.dynamo).not.toHaveBeenCalled();
    });

    it.each([1, 1000])('accepts quantity boundary %i', async (quantity) => {
        expect((await lambdaHandler(apiEvent(JSON.stringify({ ...input, quantity })))).statusCode).toBe(201);
    });

    it('does not leak database failures to the caller', async () => {
        clients.dynamo.mockRejectedValue(new Error('sensitive database details'));
        const response = await lambdaHandler(apiEvent());
        expect(response.statusCode).toBe(500);
        expect(JSON.parse(response.body)).toEqual({ message: 'Internal server error' });
        expect(JSON.stringify(jest.mocked(console.error).mock.calls)).not.toContain('sensitive database details');
    });

    it('reports missing configuration as a server error before an AWS call', async () => {
        const table = process.env.ORDERS_TABLE;
        delete process.env.ORDERS_TABLE;
        try {
            expect((await lambdaHandler(apiEvent())).statusCode).toBe(500);
            expect(clients.dynamo).not.toHaveBeenCalled();
        } finally {
            process.env.ORDERS_TABLE = table;
        }
    });
});
