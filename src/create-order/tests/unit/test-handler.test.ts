import {
    APIGatewayProxyEvent,
    APIGatewayProxyResult,
} from 'aws-lambda';

import {
    jest,
    describe,
    it,
    expect,
    beforeEach,
} from '@jest/globals';


const mockSend =
    jest.fn<(command: unknown) => Promise<unknown>>();


jest.mock('@aws-sdk/lib-dynamodb', () => ({
    DynamoDBDocumentClient: {
        from: jest.fn(() => ({
            send: mockSend,
        })),
    },

    PutCommand: jest.fn((input) => ({
        input,
    })),
}));


import { lambdaHandler } from '../../app';


describe('Create Order Lambda', () => {

    beforeEach(() => {
        mockSend.mockReset();
        mockSend.mockResolvedValue({});
    });


    it('should create an order successfully', async () => {

        const event = {
            httpMethod: 'POST',
            path: '/orders',

            body: JSON.stringify({
                customerId: '123',
                productId: 'ABC',
                quantity: 2,
            }),
        } as APIGatewayProxyEvent;


        const result: APIGatewayProxyResult =
            await lambdaHandler(event);


        expect(result.statusCode).toBe(201);


        const responseBody =
            JSON.parse(result.body);


        expect(responseBody).toMatchObject({
            customerId: '123',
            productId: 'ABC',
            quantity: 2,
            status: 'RECEIVED',
        });


        expect(responseBody.orderId)
            .toBeDefined();


        expect(responseBody.createdAt)
            .toBeDefined();


        expect(mockSend)
            .toHaveBeenCalledTimes(1);
    });


    it('should return 400 when body is missing', async () => {

        const event = {
            httpMethod: 'POST',
            path: '/orders',
            body: null,
        } as APIGatewayProxyEvent;


        const result: APIGatewayProxyResult =
            await lambdaHandler(event);


        expect(result.statusCode)
            .toBe(400);


        expect(
            JSON.parse(result.body)
        ).toEqual({
            message: 'Request body is required',
        });


        expect(mockSend)
            .not
            .toHaveBeenCalled();
    });


    it('should return 400 when required fields are missing', async () => {

        const event = {
            httpMethod: 'POST',
            path: '/orders',

            body: JSON.stringify({
                customerId: '123',
            }),
        } as APIGatewayProxyEvent;


        const result: APIGatewayProxyResult =
            await lambdaHandler(event);


        expect(result.statusCode)
            .toBe(400);


        expect(
            JSON.parse(result.body)
        ).toEqual({
            message:
                'customerId, productId and quantity are required',
        });


        expect(mockSend)
            .not
            .toHaveBeenCalled();
    });


    it('should return 500 when DynamoDB fails', async () => {

        mockSend.mockRejectedValue(
            new Error('DynamoDB error')
        );


        const event = {
            httpMethod: 'POST',
            path: '/orders',

            body: JSON.stringify({
                customerId: '123',
                productId: 'ABC',
                quantity: 2,
            }),
        } as APIGatewayProxyEvent;


        const result: APIGatewayProxyResult =
            await lambdaHandler(event);


        expect(result.statusCode)
            .toBe(500);


        expect(
            JSON.parse(result.body)
        ).toEqual({
            message: 'Internal server error',
        });


        expect(mockSend)
            .toHaveBeenCalledTimes(1);
    });

});