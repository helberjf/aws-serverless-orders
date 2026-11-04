import { randomUUID } from 'node:crypto';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { documentClient, requiredEnv } from '../shared/clients';
import { apiHandler, HttpError, jsonResponse, parseBody } from '../shared/http';
import { requireOwner } from '../shared/auth';
import { previousResponse, requestKey, sha256 } from '../shared/idempotency';
import { orderInputSchema, publicOrder, type Order } from '../shared/order';
import { outboxItem } from '../shared/outbox';

export const lambdaHandler = apiHandler('create_order', async (event) => {
    const ownerId = requireOwner(event);
    const parsed = orderInputSchema.safeParse(parseBody(event));
    if (!parsed.success)
        throw new HttpError(
            400,
            'INVALID_ORDER',
            'customerId and productId must be non-empty strings (max 128 characters); quantity must be an integer between 1 and 1000',
        );
    const key = requestKey(event);
    const idempotencyKey = sha256(JSON.stringify([ownerId, key]));
    const requestHash = sha256(JSON.stringify(parsed.data));
    const now = Math.floor(Date.now() / 1000);
    const respond = (body: unknown, replayed: boolean) => ({
        ...jsonResponse(201, body),
        headers: {
            ...jsonResponse(201, body).headers,
            'Idempotency-Key': key,
            'Idempotency-Replayed': String(replayed),
        },
    });
    const existing = await previousResponse(idempotencyKey, requestHash, now);
    if (existing) return respond(existing, true);
    const createdAt = new Date().toISOString();
    const order: Order = {
        orderId: randomUUID(),
        ownerId,
        ...parsed.data,
        status: 'RECEIVED',
        createdAt,
        updatedAt: createdAt,
    };
    const response = publicOrder(order);
    try {
        await documentClient.send(
            new TransactWriteCommand({
                TransactItems: [
                    {
                        Put: {
                            TableName: requiredEnv('ORDERS_TABLE'),
                            Item: order,
                            ConditionExpression: 'attribute_not_exists(orderId)',
                        },
                    },
                    {
                        Put: {
                            TableName: requiredEnv('IDEMPOTENCY_TABLE'),
                            Item: {
                                idempotencyKey,
                                requestHash,
                                orderId: order.orderId,
                                response,
                                expiresAt: now + 86400,
                            },
                            ConditionExpression: 'attribute_not_exists(idempotencyKey) OR expiresAt <= :now',
                            ExpressionAttributeValues: { ':now': now },
                        },
                    },
                    {
                        Put: {
                            TableName: requiredEnv('OUTBOX_TABLE'),
                            Item: outboxItem(
                                'OrderCreated',
                                order.orderId,
                                { requestId: event.requestContext.requestId },
                                createdAt,
                            ),
                            ConditionExpression: 'attribute_not_exists(eventId)',
                        },
                    },
                ],
            }),
        );
    } catch (error) {
        // Also resolves an ambiguous timeout if DynamoDB committed but its response was lost.
        const replay = await previousResponse(idempotencyKey, requestHash, now);
        if (replay) return respond(replay, true);
        throw error;
    }
    console.info({
        eventType: 'order_created',
        orderId: order.orderId,
        requestId: event.requestContext.requestId,
        status: order.status,
    });
    return respond(response, false);
});
