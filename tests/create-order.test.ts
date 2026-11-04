import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { lambdaHandler } from '../src/create-order/app';
import { sha256 } from '../src/shared/idempotency';
import { apiEvent, input, mockClients, receivedOrder, failure } from './support';

describe('create order transaction and API contract', () => {
    let clients: ReturnType<typeof mockClients>;
    const response = { orderId: receivedOrder.orderId, ...input, status: 'RECEIVED' };
    const prior = {
        requestHash: sha256(JSON.stringify(input)),
        response,
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
    };
    beforeEach(() => {
        clients = mockClients();
    });
    it('atomically persists order, idempotency response and outbox intent', async () => {
        const result = await lambdaHandler(apiEvent());
        expect(result.statusCode).toBe(201);
        expect(result.headers).toMatchObject({
            'Content-Type': 'application/json',
            'Idempotency-Replayed': 'false',
            'X-Request-Id': 'test-request',
        });
        const body = JSON.parse(result.body);
        expect(body).toMatchObject({ ...input, status: 'RECEIVED', updatedAt: expect.any(String) });
        expect(body).not.toHaveProperty('ownerId');
        const write = clients.dynamo.mock.calls.find(
            ([command]) => command instanceof TransactWriteCommand,
        )![0] as TransactWriteCommand;
        expect(write.input.TransactItems).toHaveLength(3);
        expect(write.input.TransactItems![0].Put?.Item).toMatchObject({ ...body, ownerId: 'user-a' });
        expect(write.input.TransactItems![2].Put?.Item).toMatchObject({
            eventType: 'OrderCreated',
            deliveryStatus: 'PENDING',
            orderId: body.orderId,
        });
        expect(clients.sqs).not.toHaveBeenCalled();
        expect(clients.events).not.toHaveBeenCalled();
    });
    it('returns the original response on a repeated request', async () => {
        clients.dynamo.mockResolvedValueOnce({ Item: prior });
        const result = await lambdaHandler(apiEvent());
        expect(result.statusCode).toBe(201);
        expect(JSON.parse(result.body)).toEqual(response);
        expect(result.headers?.['Idempotency-Replayed']).toBe('true');
        expect(clients.dynamo).toHaveBeenCalledTimes(1);
    });
    it('rejects reuse of a key with a different payload', async () => {
        clients.dynamo.mockResolvedValueOnce({ Item: { ...prior, requestHash: 'different' } });
        expect((await lambdaHandler(apiEvent())).statusCode).toBe(409);
    });
    it('reuses logically expired keys even before asynchronous TTL deletion', async () => {
        clients.dynamo.mockResolvedValueOnce({ Item: { ...prior, expiresAt: 0 } });
        expect((await lambdaHandler(apiEvent())).statusCode).toBe(201);
        expect(clients.dynamo.mock.calls[1][0]).toBeInstanceOf(TransactWriteCommand);
    });
    it('resolves a concurrent winner or a lost successful transaction response', async () => {
        clients.dynamo
            .mockResolvedValueOnce({})
            .mockRejectedValueOnce(failure('TransactionCanceledException'))
            .mockResolvedValueOnce({ Item: prior });
        expect((await lambdaHandler(apiEvent())).headers?.['Idempotency-Replayed']).toBe('true');
    });
    it('returns 500 for a failed transaction with no committed response', async () => {
        clients.dynamo.mockResolvedValueOnce({}).mockRejectedValueOnce(failure()).mockResolvedValueOnce({});
        const result = await lambdaHandler(apiEvent());
        expect(result.statusCode).toBe(500);
        expect(result.body).not.toContain('sensitive');
    });
    it('fails safely on a read failure', async () => {
        clients.dynamo.mockRejectedValue(failure());
        expect((await lambdaHandler(apiEvent())).statusCode).toBe(500);
    });
    it('returns 401 without identity and performs no write', async () => {
        const event = apiEvent();
        event.requestContext.authorizer = null;
        expect((await lambdaHandler(event)).statusCode).toBe(401);
        expect(clients.dynamo).not.toHaveBeenCalled();
    });
    it.each([null, '', '{', 'null', '[]', 'true', '1', '"string"'])('rejects malformed body %s', async (body) => {
        expect((await lambdaHandler(apiEvent(body))).statusCode).toBe(400);
        expect(clients.dynamo).not.toHaveBeenCalled();
    });
    it.each([
        {},
        { ...input, customerId: 5 },
        { ...input, customerId: ' ' },
        { ...input, productId: null },
        { ...input, productId: 'x'.repeat(129) },
        { ...input, quantity: '2' },
        { ...input, quantity: 0 },
        { ...input, quantity: -1 },
        { ...input, quantity: 1.5 },
        { ...input, quantity: 1001 },
    ])('rejects invalid fields %j', async (body) => {
        expect((await lambdaHandler(apiEvent(JSON.stringify(body)))).statusCode).toBe(400);
        expect(clients.dynamo).not.toHaveBeenCalled();
    });
    it.each([1, 1000])('accepts quantity boundary %i', async (quantity) => {
        expect((await lambdaHandler(apiEvent(JSON.stringify({ ...input, quantity })))).statusCode).toBe(201);
    });
    it('handles base64 and trims identifiers', async () => {
        const event = apiEvent(
            Buffer.from(JSON.stringify({ ...input, customerId: ' c ', productId: ' p ' })).toString('base64'),
        );
        event.isBase64Encoded = true;
        expect(JSON.parse((await lambdaHandler(event)).body)).toMatchObject({ customerId: 'c', productId: 'p' });
    });
    it('rejects oversized bodies', async () => {
        expect((await lambdaHandler(apiEvent('x'.repeat(16385)))).statusCode).toBe(400);
    });
    it.each(['', 'x'.repeat(129), 'white space'])('rejects invalid idempotency keys %s', async (key) => {
        const event = apiEvent();
        event.headers = { 'Idempotency-Key': key };
        expect((await lambdaHandler(event)).statusCode).toBe(400);
    });
    it('rejects duplicate key headers', async () => {
        const event = apiEvent();
        event.multiValueHeaders = { 'idempotency-key': ['a', 'b'] };
        expect((await lambdaHandler(event)).statusCode).toBe(400);
    });
    it('retains compatibility for callers without a key and returns the generated key', async () => {
        const event = apiEvent();
        event.headers = {};
        const result = await lambdaHandler(event);
        expect(result.statusCode).toBe(201);
        expect(result.headers?.['Idempotency-Key']).toMatch(/^[a-f0-9-]{36}$/);
    });
    it('uses the key from multiValueHeaders', async () => {
        const event = apiEvent();
        event.multiValueHeaders = { 'idempotency-key': ['from-multi'] };
        expect((await lambdaHandler(event)).headers?.['Idempotency-Key']).toBe('from-multi');
    });
});
