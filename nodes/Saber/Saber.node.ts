import {
	NodeOperationError,
	type IDataObject,
	type IExecuteFunctions,
	type IHttpRequestMethods,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
} from 'n8n-workflow';

import { operationRegistry, properties, type RegistryField } from './generated';
import { saberApiRequest } from './GenericFunctions';

/**
 * Coerces a raw n8n parameter value into the shape the Saber API expects for a
 * given field type. Returns `undefined` for empty values so they are omitted
 * from the request instead of sent as blanks.
 */
function coerceValue(type: RegistryField['type'], value: unknown): unknown {
	if (value === undefined || value === null) return undefined;

	if (type === 'json') {
		if (typeof value === 'string') {
			const trimmed = value.trim();
			if (trimmed === '' || trimmed === '{}' || trimmed === '[]') return undefined;
			try {
				return JSON.parse(trimmed);
			} catch {
				return value;
			}
		}
		return value;
	}

	if (type === 'number' && typeof value === 'string') {
		if (value.trim() === '') return undefined;
		const parsed = Number(value);
		return Number.isNaN(parsed) ? value : parsed;
	}

	return value;
}

export class Saber implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Saber',
		name: 'saber',
		icon: 'file:saber.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description:
			'Work with the Saber Platform API: company and contact research signals, market signals, lists, and scoring',
		defaults: {
			name: 'Saber',
		},
		inputs: ['main'],
		outputs: ['main'],
		credentials: [
			{
				name: 'saberApi',
				required: true,
			},
		],
		properties,
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const resource = this.getNodeParameter('resource', i) as string;
				const operation = this.getNodeParameter('operation', i) as string;

				const opDef = operationRegistry[resource]?.[operation];
				if (!opDef) {
					throw new NodeOperationError(
						this.getNode(),
						`Unsupported operation "${operation}" for resource "${resource}"`,
						{ itemIndex: i },
					);
				}

				let path = opDef.path;
				const body: IDataObject = {};
				const qs: IDataObject = {};
				const headers: IDataObject = {};

				const additionalFields = this.getNodeParameter('additionalFields', i, {}) as IDataObject;

				for (const field of opDef.fields) {
					let raw: unknown;
					if (field.required) {
						raw = this.getNodeParameter(field.name, i);
					} else {
						if (!(field.name in additionalFields)) continue;
						raw = additionalFields[field.name];
					}

					const value = coerceValue(field.type, raw);
					if (value === undefined) continue;

					switch (field.location) {
						case 'path':
							path = path.replace(`{${field.name}}`, encodeURIComponent(String(value)));
							break;
						case 'query':
							qs[field.name] = value as IDataObject[string];
							break;
						case 'header':
							headers[field.name] = String(value);
							break;
						case 'body':
							body[field.name] = value as IDataObject[string];
							break;
					}
				}

				const responseData = await saberApiRequest.call(
					this,
					opDef.method as IHttpRequestMethods,
					path,
					body,
					qs,
					headers,
				);

				const executionData = this.helpers.constructExecutionMetaData(
					this.helpers.returnJsonArray(responseData as IDataObject),
					{ itemData: { item: i } },
				);
				returnData.push(...executionData);
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: i },
					});
					continue;
				}
				throw error;
			}
		}

		return [returnData];
	}
}
