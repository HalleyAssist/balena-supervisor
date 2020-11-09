import * as _ from 'lodash';
import * as express from 'express';
import * as memoizee from 'memoizee';

import * as config from '../config';
import * as db from '../db';

import { generateUniqueKey } from './register-device';

export class KeyNotFoundError extends Error {}

/**
 * The schema for the `apiSecret` table in the database
 */
interface DbApiSecret {
	id: number;
	appId: number;
	serviceId: number;
	scopes: string;
	key: string;
}

export type Scope = SerializableScope<ScopeTypeKey>;
type ScopeTypeKey = keyof ScopeTypes;
type SerializableScope<T extends ScopeTypeKey> = {
	type: T;
} & ScopeTypes[T];
type ScopeCheck<T extends ScopeTypeKey> = (
	resources: Partial<ScopedResources>,
	scope: ScopeTypes[T],
) => Resolvable<boolean>;
type ScopeCheckCollection = {
	[K in ScopeTypeKey]: ScopeCheck<K>;
};

/**
 * The scopes which a key can cover.
 */
type ScopeTypes = {
	global: {};
	app: {
		appId: number;
	};
};

/**
 * The resources which can be protected with scopes.
 */
interface ScopedResources {
	apps: number[];
}

/**
 * The checks when determining if a key is scoped for a resource.
 */
const scopeChecks: ScopeCheckCollection = {
	global: () => true,
	app: (resources, { appId }) =>
		resources.apps != null && resources.apps.includes(appId),
};

export function serialiseScopes(scopes: Scope[]): string {
	return JSON.stringify(scopes);
}

export function deserialiseScopes(json: string): Scope[] {
	return JSON.parse(json);
}

export const isScoped = (
	resources: Partial<ScopedResources>,
	scopes: Scope[],
) =>
	scopes.some((scope) =>
		scopeChecks[scope.type](resources, (scope as unknown) as any),
	);

export type AuthorizedRequest = express.Request & {
	auth: {
		isScoped: (resources: Partial<ScopedResources>) => boolean;
		apiKey: string;
		scopes: Scope[];
	};
};
export type AuthorizedRequestHandler = (
	req: AuthorizedRequest,
	res: express.Response,
	next: express.NextFunction,
) => void;

// empty until populated in `initialized`
export let cloudApiKey: string = '';

// should be called before trying to use this singleton
export const initialized = (async () => {
	await db.initialized;

	// make sure we have an API key which the cloud will use to call us
	await generateCloudKey();
})();

/**
 * This middleware will extract an API key used to make a call, and then expand it out to provide
 * access to the scopes it has. The `req` will be updated to include this `auth` data.
 *
 * E.g. `req.auth.scopes: []`
 *
 * @param req
 * @param res
 * @param next
 */
export const authMiddleware: AuthorizedRequestHandler = async (
	req,
	res,
	next,
) => {
	// grab the API key used for the request
	const apiKey = getApiKeyFromRequest(req) ?? '';

	// store the key in the request, and an empty scopes array to populate after resolving the key scopes
	req.auth = {
		apiKey,
		scopes: [],
		isScoped: () => false,
	};

	try {
		const conf = await config.getMany(['localMode', 'unmanaged', 'osVariant']);

		// we only need to check the API key if a) unmanaged and on a production image, or b) managed and not in local mode
		const needsAuth = conf.unmanaged
			? conf.osVariant === 'prod'
			: !conf.localMode;

		// no need to authenticate, shortcut
		if (!needsAuth) {
			return next();
		}

		// if we have a key, find the scopes and add them to the request
		if (apiKey && apiKey !== '') {
			await initialized;
			const scopes = await getScopesForKey(apiKey);

			if (scopes != null) {
				// keep the scopes for later incase they're desired
				req.auth.scopes.push(...scopes);

				// which resources are scoped...
				req.auth.isScoped = (resources) => isScoped(resources, req.auth.scopes);

				return next();
			}
		}

		// we do not have a valid key...
		return res.sendStatus(401);
	} catch (err) {
		console.error(err);
		res.status(503).send(`Unexpected error: ${err}`);
	}
};

function isEqualScope(a: Scope, b: Scope): boolean {
	return _.isEqual(a, b);
}

function getApiKeyFromRequest(req: express.Request): string | undefined {
	// Check query for key
	if (req.query.apikey) {
		return req.query.apikey;
	}

	// Get Authorization header to search for key
	const authHeader = req.get('Authorization');

	// Check header for key
	if (!authHeader) {
		return undefined;
	}

	// Check authHeader with various schemes
	const match = authHeader.match(/^(?:ApiKey|Bearer) (\w+)$/i);

	// Return key from match or undefined
	return match?.[1];
}

export type GenerateKeyOptions = { force: boolean; scopes: Scope[] };

export async function getScopesForKey(key: string): Promise<Scope[] | null> {
	const apiKey = await getApiKeyByKey(key);

	// null means the key wasn't known...
	if (apiKey == null) {
		return null;
	}

	return deserialiseScopes(apiKey.scopes);
}

export async function generateScopedKey(
	appId: number,
	serviceId: number,
	options?: Partial<GenerateKeyOptions>,
): Promise<string> {
	await initialized;
	return await generateKey(appId, serviceId, options);
}

export async function generateCloudKey(
	force: boolean = false,
): Promise<string> {
	cloudApiKey = await generateKey(0, 0, {
		force,
		scopes: [{ type: 'global' }],
	});
	return cloudApiKey;
}

export async function refreshKey(key: string): Promise<string> {
	const apiKey = await getApiKeyByKey(key);

	if (apiKey == null) {
		throw new KeyNotFoundError();
	}

	const { appId, serviceId, scopes } = apiKey;

	// if this is a cloud key that is being refreshed
	if (appId === 0 && serviceId === 0) {
		return await generateCloudKey(true);
	}

	// generate a new key, expiring the old one...
	const newKey = await generateScopedKey(appId, serviceId, {
		force: true,
		scopes: deserialiseScopes(scopes),
	});

	// return the regenerated key
	return newKey;
}

/**
 * A cached lookup of the database key
 */
const getApiKeyForService = memoizee(
	async (appId: number, serviceId: number): Promise<DbApiSecret[]> => {
		await db.initialized;

		return await db.models('apiSecret').where({ appId, serviceId }).select();
	},
	{
		promise: true,
		maxAge: 60000, // 1 minute
		normalizer: ([appId, serviceId]) => `${appId}-${serviceId}`,
	},
);

/**
 * A cached lookup of the database key for a given application/service pair
 */
const getApiKeyByKey = memoizee(
	async (key: string): Promise<DbApiSecret> => {
		await db.initialized;

		const [apiKey] = await db.models('apiSecret').where({ key }).select();
		return apiKey;
	},
	{
		promise: true,
		maxAge: 60000, // 1 minute
	},
);

/**
 * All key generate logic should come though this method. It handles cache clearing.
 *
 * @param appId
 * @param serviceId
 * @param options
 */
async function generateKey(
	appId: number,
	serviceId: number,
	options?: Partial<GenerateKeyOptions>,
): Promise<string> {
	// set default options
	const { force, scopes }: GenerateKeyOptions = {
		force: false,
		scopes: [{ type: 'app', appId }],
		...options,
	};

	// grab the existing API key info
	const secrets = await getApiKeyForService(appId, serviceId);

	// if we need a new key
	if (secrets.length === 0 || force) {
		// are forcing a new key?
		if (force) {
			await db.models('apiSecret').where({ appId, serviceId }).del();
		}

		// remove the cached lookup for the key
		const [apiKey] = secrets;
		if (apiKey != null) {
			getApiKeyByKey.clear(apiKey.key);
		}

		// remove the cached value for this lookup
		getApiKeyForService.clear(appId, serviceId);

		// return a new API key
		return await createNewKey(appId, serviceId, scopes);
	}

	// grab the current secret and scopes
	const [currentSecret] = secrets;
	const currentScopes: Scope[] = JSON.parse(currentSecret.scopes);

	const scopesWeAlreadyHave = scopes.filter((desiredScope) =>
		currentScopes.some((currentScope) =>
			isEqualScope(desiredScope, currentScope),
		),
	);

	// if we have the correct scopes, then return our existing key...
	if (
		scopes.length === currentScopes.length &&
		scopesWeAlreadyHave.length === currentScopes.length
	) {
		return currentSecret.key;
	}

	// forcibly get a new key...
	return await generateKey(appId, serviceId, { ...options, force: true });
}

/**
 * Generates a new key value and inserts it into the DB.
 *
 * @param appId
 * @param serviceId
 * @param scopes
 */
async function createNewKey(appId: number, serviceId: number, scopes: Scope[]) {
	const key = generateUniqueKey();
	await db.models('apiSecret').insert({
		appId,
		serviceId,
		key,
		scopes: serialiseScopes(scopes),
	});

	// return the new key
	return key;
}
