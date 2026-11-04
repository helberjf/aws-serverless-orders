import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { documentClient, requiredEnv } from '../shared/clients';
import { apiHandler, HttpError, jsonResponse } from '../shared/http';
import { requireOwner } from '../shared/auth';
import { isOrderId, orderSchema, publicOrder } from '../shared/order';

export const lambdaHandler = apiHandler('get_order', async (event) => {
    const ownerId = requireOwner(event);
    const orderId = event.pathParameters?.orderId;
    if (!isOrderId(orderId)) throw new HttpError(400, 'INVALID_ORDER_ID', 'orderId must be a UUID v4');
    const { Item } = await documentClient.send(
        new GetCommand({ TableName: requiredEnv('ORDERS_TABLE'), Key: { orderId }, ConsistentRead: true }),
    );
    // Identical response for nonexistent and inaccessible orders prevents cross-user enumeration.
    if (!Item || Item.ownerId !== ownerId) throw new HttpError(404, 'NOT_FOUND', 'Order not found');
    return jsonResponse(200, publicOrder(orderSchema.parse(Item)));
});
