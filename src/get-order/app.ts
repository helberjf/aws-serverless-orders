import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { documentClient, requiredEnv } from '../shared/clients';
import { jsonResponse, logError } from '../shared/http';
import { isOrderId } from '../shared/order';

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const orderId = event.pathParameters?.orderId;
    if (!isOrderId(orderId)) return jsonResponse(400, { message: 'orderId must be a UUID v4' });
    try {
        const { Item } = await documentClient.send(
            new GetCommand({ TableName: requiredEnv('ORDERS_TABLE'), Key: { orderId }, ConsistentRead: true }),
        );
        return Item ? jsonResponse(200, Item) : jsonResponse(404, { message: 'Order not found' });
    } catch (error) {
        logError('get_order_failed', error, { orderId, requestId: event.requestContext?.requestId });
        return jsonResponse(500, { message: 'Internal server error' });
    }
};
