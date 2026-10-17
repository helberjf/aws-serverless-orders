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


const mockDynamoSend =
    jest.fn<(command: unknown) => Promise<unknown>>();

const mockSqsSend =
    jest.fn<(command: unknown) => Promise<unknown>>();


/*
 * Mock DynamoDB
 */
jest.mock('@aws-sdk/lib-dynamodb', () => ({
    DynamoDBDocumentClient: {
        from: jest.fn(() => ({
            send: mockDynamoSend,
        })),
    },

    PutCommand: jest.fn((input) => ({
        input,
    })),
}));


/*
 * Mock SQS
 */
jest.mock('@aws-sdk/client-sqs', () => ({
    SQSClient: jest.fn(() => ({
        send: mockSqsSend,
    })),

    SendMessageCommand: jest.fn((input) => ({
        input,
    })),
}));


/*
 * Import da Lambda somente depois dos mocks
 */
import { lambdaHandler } from '../../app';


describe('Create Order Lambda', () => {

    beforeEach(() => {

        mockDynamoSend.mockReset();
        mockSqsSend.mockReset();

        mockDynamoSend.mockResolvedValue({});
        mockSqsSend.mockResolvedValue({});

    });


    it('should create an order and send message to SQS successfully', async () => {

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
            .toBe(201);


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


        /*
         * DynamoDB deve ter sido chamado uma vez
         */
        expect(mockDynamoSend)
            .toHaveBeenCalledTimes(1);


        /*
         * SQS deve ter sido chamado uma vez
         */
        expect(mockSqsSend)
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


        expect(mockDynamoSend)
            .not
            .toHaveBeenCalled();


        expect(mockSqsSend)
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


        expect(mockDynamoSend)
            .not
            .toHaveBeenCalled();


        expect(mockSqsSend)
            .not
            .toHaveBeenCalled();

    });


    it('should return 500 when DynamoDB fails', async () => {

        mockDynamoSend.mockRejectedValue(
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


        expect(mockDynamoSend)
            .toHaveBeenCalledTimes(1);


        /*
         * Se DynamoDB falhou,
         * nem devemos chegar ao SQS
         */
        expect(mockSqsSend)
            .not
            .toHaveBeenCalled();

    });


    it('should return 500 when SQS fails', async () => {

        mockSqsSend.mockRejectedValue(
            new Error('SQS error')
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


        /*
         * DynamoDB executou antes do SQS
         */
        expect(mockDynamoSend)
            .toHaveBeenCalledTimes(1);


        expect(mockSqsSend)
            .toHaveBeenCalledTimes(1);

    });

});