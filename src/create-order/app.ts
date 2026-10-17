import {
    APIGatewayProxyEvent,
    APIGatewayProxyResult,
} from 'aws-lambda';

import { randomUUID } from 'crypto';

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

import {
    DynamoDBDocumentClient,
    PutCommand,
} from '@aws-sdk/lib-dynamodb';


const dynamoClient = new DynamoDBClient({});

const documentClient =
    DynamoDBDocumentClient.from(dynamoClient);


const ORDERS_TABLE =
    process.env.ORDERS_TABLE!;


export const lambdaHandler = async (
    event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {

    try {

        if (!event.body) {

            return {
                statusCode: 400,
                body: JSON.stringify({
                    message: 'Request body is required',
                }),
            };

        }


        const body = JSON.parse(event.body);


        const {
            customerId,
            productId,
            quantity,
        } = body;


        if (!customerId || !productId || !quantity) {

            return {
                statusCode: 400,
                body: JSON.stringify({
                    message:
                        'customerId, productId and quantity are required',
                }),
            };

        }


        const order = {

            orderId: randomUUID(),

            customerId,

            productId,

            quantity,

            status: 'RECEIVED',

            createdAt: new Date().toISOString(),

        };


        await documentClient.send(

            new PutCommand({

                TableName: ORDERS_TABLE,

                Item: order,

            }),

        );


        return {

            statusCode: 201,

            headers: {
                'Content-Type': 'application/json',
            },

            body: JSON.stringify(order),

        };


    } catch (error) {

        console.error(
            'Error creating order:',
            error,
        );


        return {

            statusCode: 500,

            body: JSON.stringify({
                message: 'Internal server error',
            }),

        };

    }

};