import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	IWebhookFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';

type SaberContext =
	| IExecuteFunctions
	| IHookFunctions
	| ILoadOptionsFunctions
	| IWebhookFunctions;

/**
 * Makes an authenticated request against the Saber Platform API. Auth (the
 * `Authorization: Bearer` header) is injected from the `saberApi` credential;
 * the base URL is read from the same credential.
 */
export async function saberApiRequest(
	this: SaberContext,
	method: IHttpRequestMethods,
	path: string,
	body: IDataObject = {},
	qs: IDataObject = {},
	headers: IDataObject = {},
): Promise<any> {
	const credentials = await this.getCredentials('saberApi');
	const baseUrl = ((credentials.baseUrl as string) || 'https://api.saber.app').replace(/\/+$/, '');

	const options: IHttpRequestOptions = {
		method,
		url: `${baseUrl}${path}`,
		body,
		qs,
		headers,
		json: true,
	};

	if (!Object.keys(body).length) delete options.body;
	if (!Object.keys(qs).length) delete options.qs;
	if (!Object.keys(headers).length) delete options.headers;

	try {
		return await this.helpers.httpRequestWithAuthentication.call(this, 'saberApi', options);
	} catch (error) {
		throw new NodeApiError(this.getNode(), error as JsonObject);
	}
}

/**
 * Walks an offset-paginated Saber list endpoint until `hasMore` is false (or
 * `limit` items have been collected), returning the flattened `items` array.
 */
export async function saberApiRequestAllItems(
	this: SaberContext,
	method: IHttpRequestMethods,
	path: string,
	qs: IDataObject = {},
	limit = 0,
): Promise<IDataObject[]> {
	const results: IDataObject[] = [];
	const pageSize = 100;
	let offset = (qs.offset as number) ?? 0;

	do {
		const page = await saberApiRequest.call(this, method, path, {}, { ...qs, limit: pageSize, offset });
		const items = (page.items as IDataObject[]) ?? [];
		results.push(...items);
		if (!page.hasMore || items.length === 0) break;
		offset += items.length;
		if (limit > 0 && results.length >= limit) break;
	} while (true);

	return limit > 0 ? results.slice(0, limit) : results;
}
