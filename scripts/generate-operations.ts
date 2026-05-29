/**
 * Authoring-time generator. NOT shipped in the published package and NOT a
 * runtime dependency of the node — it only runs locally (`npm run generate`)
 * to regenerate `nodes/Saber/generated.ts` from the public Saber API spec.
 * Verified n8n nodes may not have runtime dependencies; js-yaml is a
 * devDependency used here only.
 *
 * By default it fetches the published spec from `SPEC_URL`. Pass a local file
 * path as the first CLI argument to generate from a local copy instead. It
 * groups every operation into a clean n8n resource/operation taxonomy,
 * resolves request-body schemas, and emits:
 *   - `properties`: the INodeProperties[] that drive the node UI
 *   - `operationRegistry`: a method/path/field map the node's execute() uses
 *     to build each HTTP request
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';

const SPEC_URL = process.env.SABER_OPENAPI_URL ?? 'https://api.saber.app/v1/openapi.yaml';
const OUT_PATH = resolve(__dirname, '..', 'nodes', 'Saber', 'generated.ts');

type Json = Record<string, any>;

// ---------------------------------------------------------------------------
// Resource taxonomy. Ordered, first match wins (most specific paths first).
// ---------------------------------------------------------------------------
interface ResourceRule {
	test: RegExp;
	key: string;
	name: string;
}

const RESOURCE_RULES: ResourceRule[] = [
	{ test: /^\/v1\/companies\/signals\/templates/, key: 'companySignalTemplate', name: 'Company Signal Template' },
	{ test: /^\/v1\/companies\/signals\/summaries/, key: 'companySignalSummary', name: 'Company Signal Summary' },
	{ test: /^\/v1\/companies\/signals\/subscriptions/, key: 'companySignalSubscription', name: 'Company Signal Subscription' },
	{ test: /^\/v1\/companies\/signals/, key: 'companySignal', name: 'Company Signal' },
	{ test: /^\/v1\/companies\/(lists|search)/, key: 'companyList', name: 'Company List' },
	{ test: /^\/v1\/contacts\/signals/, key: 'contactSignal', name: 'Contact Signal' },
	{ test: /^\/v1\/contacts\/lists/, key: 'contactList', name: 'Contact List' },
	{ test: /^\/v1\/contacts\/(research|find-email|search)/, key: 'contact', name: 'Contact' },
	{ test: /^\/v1\/market-signals\/subscriptions/, key: 'marketSignalSubscription', name: 'Market Signal Subscription' },
	{ test: /^\/v1\/scoring/, key: 'scoring', name: 'Scoring' },
	{ test: /^\/v1\/(credits|connectors|organisation)/, key: 'account', name: 'Account' },
];

function resourceForPath(path: string): ResourceRule {
	const rule = RESOURCE_RULES.find((r) => r.test.test(path));
	if (!rule) throw new Error(`No resource rule matches path: ${path}`);
	return rule;
}

// ---------------------------------------------------------------------------
// Field model shared between UI generation and the runtime registry.
// ---------------------------------------------------------------------------
type FieldLocation = 'path' | 'query' | 'body' | 'header';
type N8nType = 'string' | 'number' | 'boolean' | 'options' | 'json' | 'dateTime';

interface FieldDef {
	name: string;
	location: FieldLocation;
	type: N8nType;
	required: boolean;
	description?: string;
	default?: any;
	options?: Array<{ name: string; value: string }>;
}

interface OperationDef {
	method: string;
	path: string;
	fields: FieldDef[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function titleCase(input: string): string {
	const spaced = input
		.replace(/[_-]+/g, ' ')
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/\s+/g, ' ')
		.trim();
	return spaced
		.split(' ')
		.map((w) => (w.length ? w[0].toUpperCase() + w.slice(1) : w))
		.join(' ');
}

function firstLine(text: string | undefined, max = 220): string | undefined {
	if (!text) return undefined;
	const line = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
	const clean = line.replace(/\*\*/g, '').replace(/`/g, '').trim();
	if (!clean) return undefined;
	return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function resolveRef(spec: Json, ref: string): Json {
	const parts = ref.replace(/^#\//, '').split('/');
	let cur: Json = spec;
	for (const p of parts) cur = cur?.[p];
	if (!cur) throw new Error(`Unable to resolve $ref: ${ref}`);
	return cur;
}

/** Resolve a schema node one level: follow $ref and merge allOf. */
function resolveSchema(spec: Json, schema: Json | undefined): Json {
	if (!schema) return {};
	if (schema.$ref) return resolveSchema(spec, resolveRef(spec, schema.$ref));
	if (Array.isArray(schema.allOf)) {
		const merged: Json = { type: 'object', properties: {}, required: [] };
		for (const part of schema.allOf) {
			const r = resolveSchema(spec, part);
			Object.assign(merged.properties, r.properties ?? {});
			if (Array.isArray(r.required)) merged.required.push(...r.required);
		}
		return merged;
	}
	return schema;
}

function mapType(schema: Json): { type: N8nType; options?: Array<{ name: string; value: string }>; default: any } {
	const t = Array.isArray(schema.type) ? schema.type.find((x: string) => x !== 'null') : schema.type;
	if (Array.isArray(schema.enum) && schema.enum.length) {
		const options = schema.enum
			.filter((v: any) => v !== null)
			.map((v: any) => ({ name: titleCase(String(v)), value: String(v) }))
			// n8n verification requires options sorted alphabetically by display name.
			.sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));
		return {
			type: 'options',
			options,
			default: schema.default ?? String(schema.enum.find((v: any) => v !== null)),
		};
	}
	switch (t) {
		case 'integer':
		case 'number':
			return { type: 'number', default: schema.default ?? 0 };
		case 'boolean':
			return { type: 'boolean', default: schema.default ?? false };
		case 'array':
			return { type: 'json', default: '[]' };
		case 'object':
			return { type: 'json', default: '{}' };
		case 'string':
			if (schema.format === 'date-time') return { type: 'dateTime', default: '' };
			return { type: 'string', default: schema.default ?? '' };
		default:
			// Unknown / mixed → safest is a JSON field.
			return { type: 'json', default: '{}' };
	}
}

// ---------------------------------------------------------------------------
// Build operations from the spec.
// ---------------------------------------------------------------------------
interface BuiltOp {
	resourceKey: string;
	resourceName: string;
	operation: string; // operationId
	label: string; // summary
	description?: string;
	def: OperationDef;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

function buildField(spec: Json, name: string, schema: Json, location: FieldLocation, required: boolean, descOverride?: string): FieldDef {
	const resolved = resolveSchema(spec, schema);
	const mapped = mapType(resolved);
	const field: FieldDef = {
		name,
		location,
		type: mapped.type,
		required,
		default: mapped.default,
	};
	if (mapped.options) field.options = mapped.options;
	const desc = firstLine(descOverride ?? resolved.description ?? schema.description);
	if (desc) field.description = desc;
	return field;
}

function buildOperations(spec: Json): BuiltOp[] {
	const ops: BuiltOp[] = [];
	const paths: Json = spec.paths ?? {};
	for (const [path, pathItem] of Object.entries<Json>(paths)) {
		for (const method of HTTP_METHODS) {
			const op = pathItem[method];
			if (!op) continue;
			const rule = resourceForPath(path);
			const fields: FieldDef[] = [];

			// Parameters: path / query / header.
			for (const rawParam of op.parameters ?? []) {
				const param = rawParam.$ref ? resolveRef(spec, rawParam.$ref) : rawParam;
				const loc = param.in as FieldLocation;
				if (!['path', 'query', 'header'].includes(loc)) continue;
				fields.push(buildField(spec, param.name, param.schema ?? {}, loc, !!param.required, param.description));
			}

			// Request body (application/json).
			const bodySchemaRef = op.requestBody?.content?.['application/json']?.schema;
			if (bodySchemaRef) {
				const bodySchema = resolveSchema(spec, bodySchemaRef);
				const requiredSet = new Set<string>(bodySchema.required ?? []);
				for (const [propName, propSchema] of Object.entries<Json>(bodySchema.properties ?? {})) {
					fields.push(buildField(spec, propName, propSchema, 'body', requiredSet.has(propName)));
				}
			}

			ops.push({
				resourceKey: rule.key,
				resourceName: rule.name,
				operation: op.operationId,
				label: (op.summary ?? op.operationId).trim(),
				description: firstLine(op.description) ?? firstLine(op.summary),
				def: { method: method.toUpperCase(), path, fields },
			});
		}
	}
	return ops;
}

// ---------------------------------------------------------------------------
// Generate n8n INodeProperties.
// ---------------------------------------------------------------------------
function fieldToProperty(field: FieldDef, displayOptions: Json, forceOptional = false): Json {
	const prop: Json = {
		displayName: field.name === 'X-Sbr-Timeout-Sec' ? 'Timeout (Seconds)' : titleCase(field.name),
		name: field.name,
		type: field.type,
		default: field.default ?? (field.type === 'boolean' ? false : field.type === 'number' ? 0 : ''),
	};
	if (field.description) prop.description = field.description;
	if (field.type === 'options' && field.options) prop.options = field.options;
	if (field.type === 'json') prop.typeOptions = { rows: 4 };
	if (!forceOptional && field.required) {
		prop.required = true;
		prop.displayOptions = displayOptions;
	}
	return prop;
}

function buildProperties(ops: BuiltOp[]): Json[] {
	const properties: Json[] = [];

	// Stable resource ordering follows RESOURCE_RULES declaration order.
	const resourceOrder = RESOURCE_RULES.map((r) => r.key);
	const byResource = new Map<string, BuiltOp[]>();
	for (const op of ops) {
		if (!byResource.has(op.resourceKey)) byResource.set(op.resourceKey, []);
		byResource.get(op.resourceKey)!.push(op);
	}

	const resourceOptions = resourceOrder
		.filter((k) => byResource.has(k))
		.map((k) => {
			const name = RESOURCE_RULES.find((r) => r.key === k)!.name;
			return { name, value: k };
		});

	// 1. Resource selector.
	properties.push({
		displayName: 'Resource',
		name: 'resource',
		type: 'options',
		noDataExpression: true,
		options: resourceOptions,
		default: resourceOptions[0].value,
	});

	// 2. Per-resource operation selector + 3. per-operation fields.
	for (const resourceKey of resourceOrder) {
		const resourceOps = byResource.get(resourceKey);
		if (!resourceOps) continue;

		properties.push({
			displayName: 'Operation',
			name: 'operation',
			type: 'options',
			noDataExpression: true,
			displayOptions: { show: { resource: [resourceKey] } },
			options: resourceOps.map((op) => ({
				name: op.label,
				value: op.operation,
				action: op.label,
				...(op.description ? { description: op.description } : {}),
			})),
			default: resourceOps[0].operation,
		});

		for (const op of resourceOps) {
			const show = { resource: [resourceKey], operation: [op.operation] };
			const requiredFields = op.def.fields.filter((f) => f.required);
			const optionalFields = op.def.fields.filter((f) => !f.required);

			for (const field of requiredFields) {
				properties.push(fieldToProperty(field, { show }));
			}

			if (optionalFields.length) {
				properties.push({
					displayName: 'Additional Fields',
					name: 'additionalFields',
					type: 'collection',
					placeholder: 'Add Field',
					default: {},
					displayOptions: { show },
					options: optionalFields.map((f) => fieldToProperty(f, { show }, true)),
				});
			}
		}
	}

	return properties;
}

// ---------------------------------------------------------------------------
// Emit the generated module.
// ---------------------------------------------------------------------------
function buildRegistry(ops: BuiltOp[]): Json {
	const registry: Json = {};
	for (const op of ops) {
		registry[op.resourceKey] ??= {};
		registry[op.resourceKey][op.operation] = {
			method: op.def.method,
			path: op.def.path,
			fields: op.def.fields.map((f) => ({
				name: f.name,
				location: f.location,
				type: f.type,
				required: f.required,
			})),
		};
	}
	return registry;
}

async function loadSpec(): Promise<Json> {
	const fileArg = process.argv[2];
	if (fileArg) {
		return yaml.load(readFileSync(resolve(fileArg), 'utf8')) as Json;
	}
	const res = await fetch(SPEC_URL);
	if (!res.ok) {
		throw new Error(`Failed to fetch OpenAPI spec from ${SPEC_URL}: ${res.status} ${res.statusText}`);
	}
	return yaml.load(await res.text()) as Json;
}

async function main(): Promise<void> {
	const spec = await loadSpec();
	const ops = buildOperations(spec);
	const properties = buildProperties(ops);
	const registry = buildRegistry(ops);

	const header = `/**
 * AUTO-GENERATED by scripts/generate-operations.ts from the Saber OpenAPI
 * spec. Do not edit by hand — run \`npm run generate\` to refresh.
 *
 * Covers ${ops.length} operations across ${new Set(ops.map((o) => o.resourceKey)).size} resources.
 */
import type { INodeProperties } from 'n8n-workflow';

export type FieldLocation = 'path' | 'query' | 'body' | 'header';

export interface RegistryField {
	name: string;
	location: FieldLocation;
	type: 'string' | 'number' | 'boolean' | 'options' | 'json' | 'dateTime';
	required: boolean;
}

export interface RegistryOperation {
	method: string;
	path: string;
	fields: RegistryField[];
}

export type OperationRegistry = Record<string, Record<string, RegistryOperation>>;
`;

	const body = `
export const properties: INodeProperties[] = ${JSON.stringify(properties, null, 2)};

export const operationRegistry: OperationRegistry = ${JSON.stringify(registry, null, 2)};
`;

	writeFileSync(OUT_PATH, header + body + '\n', 'utf8');
	console.log(`Generated ${ops.length} operations across ${Object.keys(registry).length} resources -> ${OUT_PATH}`);
	for (const [res, opsObj] of Object.entries<Json>(registry)) {
		console.log(`  ${res}: ${Object.keys(opsObj).length}`);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
