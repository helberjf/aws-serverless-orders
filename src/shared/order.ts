import { z } from 'zod';

export const orderInputSchema = z.object({
    customerId: z.string().trim().min(1).max(128),
    productId: z.string().trim().min(1).max(128),
    quantity: z.number().int().min(1).max(1000),
});
export type OrderInput = z.infer<typeof orderInputSchema>;
export const orderIdSchema = z.uuid({ version: 'v4' });
export const orderSchema = orderInputSchema.extend({
    orderId: orderIdSchema,
    ownerId: z.string().min(1),
    status: z.enum(['RECEIVED', 'PROCESSED']),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    processedAt: z.iso.datetime().optional(),
    fulfillmentId: z.string().optional(),
});
export type Order = z.infer<typeof orderSchema>;
export function isOrderId(value: unknown): value is string {
    return orderIdSchema.safeParse(value).success;
}
export function publicOrder(order: Order): Omit<Order, 'ownerId'> {
    return orderSchema.omit({ ownerId: true }).parse(order);
}
export const processingMessageSchema = z.object({ orderId: orderIdSchema });
