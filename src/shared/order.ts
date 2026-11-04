export interface OrderInput {
    customerId: string;
    productId: string;
    quantity: number;
}

export function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isOrderId(value: unknown): value is string {
    return (
        typeof value === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    );
}

export function parseOrderInput(value: unknown): OrderInput | undefined {
    if (!isObject(value)) return undefined;
    const { customerId, productId, quantity } = value;
    if (
        typeof customerId !== 'string' ||
        !customerId.trim() ||
        customerId.trim().length > 128 ||
        typeof productId !== 'string' ||
        !productId.trim() ||
        productId.trim().length > 128 ||
        typeof quantity !== 'number' ||
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > 1000
    )
        return undefined;
    return { customerId: customerId.trim(), productId: productId.trim(), quantity };
}
