import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { documentClient, requiredEnv } from '../shared/clients';
import { jsonResponse, logError } from '../shared/http';
import { parseOrderInput } from '../shared/order';

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    if (!event.body) return jsonResponse(400, { message: 'Request body is required' });

    let body: unknown;
    try {
        body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body);
    } catch {
        return jsonResponse(400, { message: 'Request body must contain valid JSON' });
    }

    const input = parseOrderInput(body);
    if (!input) {
        return jsonResponse(400, {
            message:
                'customerId and productId must be non-empty strings (max 128 characters); quantity must be an integer between 1 and 1000',
        });
    }

    const order = { orderId: randomUUID(), ...input, status: 'RECEIVED', createdAt: new Date().toISOString() };
    try {
        // The committed insert is the source of the stream event: no database/SQS dual write.
        await documentClient.send(
            new PutCommand({
                TableName: requiredEnv('ORDERS_TABLE'),
                Item: order,
                ConditionExpression: 'attribute_not_exists(orderId)',
            }),
        );
        return jsonResponse(201, order);
    } catch (error) {
        logError('create_order_failed', error, { requestId: event.requestContext?.requestId });
        return jsonResponse(500, { message: 'Internal server error' });
    }
};
