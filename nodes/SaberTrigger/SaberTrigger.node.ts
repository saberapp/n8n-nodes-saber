import type {
	IDataObject,
	IHookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';

import { saberApiRequest } from '../Saber/GenericFunctions';

/**
 * Saber Trigger. Saber's public API has no generic webhook-subscription CRUD;
 * instead, a Market Signal subscription delivers matched signals to a
 * `webhookUrl` on each polling interval. This trigger creates such a
 * subscription pointed at n8n's webhook URL when the workflow activates, and
 * removes it on deactivation.
 */
export class SaberTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Saber Trigger',
		name: 'saberTrigger',
		icon: 'file:saber.svg',
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["signalType"]}}',
		description: 'Starts a workflow when Saber delivers new market signals',
		defaults: {
			name: 'Saber Trigger',
		},
		inputs: [],
		outputs: ['main'],
		credentials: [
			{
				name: 'saberApi',
				required: true,
			},
		],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName: 'Signal Type',
				name: 'signalType',
				type: 'options',
				noDataExpression: true,
				required: true,
				default: 'JOB_POSTS',
				description: 'The type of market signal to monitor',
				options: [
					{ name: 'Fundraising', value: 'FUND_RAISED' },
					{ name: 'IPO', value: 'IPO' },
					{ name: 'Job Posts', value: 'JOB_POSTS' },
					{ name: 'LinkedIn Post', value: 'LINKEDIN_POST' },
					{ name: 'Recent Investment', value: 'RECENT_INVESTMENT' },
				],
			},
			{
				displayName: 'Subscription Name',
				name: 'name',
				type: 'string',
				default: '',
				description: 'Optional display name for the subscription in Saber',
			},
			{
				displayName: 'Polling Interval',
				name: 'interval',
				type: 'options',
				default: 'daily',
				description: 'How often Saber checks for new matching signals',
				options: [
					{ name: 'Daily', value: 'daily' },
					{ name: 'Weekly', value: 'weekly' },
				],
			},
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				options: [
					{
						displayName: 'Prompt',
						name: 'prompt',
						type: 'string',
						typeOptions: { rows: 2 },
						default: '',
						description: 'Natural-language prompt for AI-based filter generation (Job Posts only)',
					},
					{
						displayName: 'Filters (JSON)',
						name: 'filters',
						type: 'json',
						default: '{}',
						description: 'Subscription filters. The schema depends on the selected signal type.',
					},
					{
						displayName: 'Signals Per Interval',
						name: 'intervalSignalLimit',
						type: 'number',
						default: 100,
						description: 'Maximum number of signals to deliver per polling interval (1-10000)',
					},
				],
			},
		],
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const webhookData = this.getWorkflowStaticData('node');
				return Boolean(webhookData.subscriptionId);
			},

			async create(this: IHookFunctions): Promise<boolean> {
				const webhookUrl = this.getNodeWebhookUrl('default') as string;
				const signalType = this.getNodeParameter('signalType') as string;
				const name = this.getNodeParameter('name', '') as string;
				const interval = this.getNodeParameter('interval', 'daily') as string;
				const additionalFields = this.getNodeParameter('additionalFields', {}) as IDataObject;

				const body: IDataObject = {
					type: signalType,
					webhookUrl,
					interval,
				};
				if (name) body.name = name;
				if (additionalFields.prompt) body.prompt = additionalFields.prompt;
				if (additionalFields.intervalSignalLimit !== undefined) {
					body.intervalSignalLimit = additionalFields.intervalSignalLimit;
				}
				if (typeof additionalFields.filters === 'string') {
					const trimmed = additionalFields.filters.trim();
					if (trimmed && trimmed !== '{}') {
						try {
							body.filters = JSON.parse(trimmed);
						} catch {
							body.filters = additionalFields.filters;
						}
					}
				} else if (additionalFields.filters) {
					body.filters = additionalFields.filters;
				}

				const response = await saberApiRequest.call(
					this,
					'POST',
					'/v1/market-signals/subscriptions',
					body,
				);

				const webhookData = this.getWorkflowStaticData('node');
				webhookData.subscriptionId = (response.id ?? response.subscriptionId) as string;
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const webhookData = this.getWorkflowStaticData('node');
				if (!webhookData.subscriptionId) return true;
				try {
					await saberApiRequest.call(
						this,
						'DELETE',
						`/v1/market-signals/subscriptions/${webhookData.subscriptionId}`,
					);
				} catch {
					// Subscription may already be gone; clear local state regardless.
				}
				delete webhookData.subscriptionId;
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const body = this.getBodyData();

		// Market-signal deliveries may batch multiple signals in a `signals`
		// array; emit one item per signal when present, otherwise the payload.
		const signals = (body as IDataObject).signals;
		const data = Array.isArray(signals) ? (signals as IDataObject[]) : [body as IDataObject];

		return {
			workflowData: [this.helpers.returnJsonArray(data)],
		};
	}
}
