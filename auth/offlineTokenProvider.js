// Copyright 2021-2026 ONDEWO GmbH
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//

// D18 headless-SDK auth helper (keycloak-migration-plan §7.8 + D18).
//
// One-time ROPC login (grant_type=password, scope=offline_access) against the PUBLIC SDK client
// `ondewo-nlu-cai-sdk-public` (no client_secret -- Q1), then a bounded background loop that refreshes
// the short-lived access token from the offline refresh token before it expires. The current access
// token is exposed for an `Authorization: Bearer <token>` gRPC metadata header. The refresh loop stops
// after `tokenExpirationInS` (if given) has elapsed since login.

'use strict';

// Seconds of head-room subtracted from a token's `expires_in` so the refresh fires before the access
// token actually lapses (covers clock skew + the round-trip to Keycloak).
const REFRESH_SKEW_IN_S = 30;

// Lower bound for the scheduled refresh delay so a tiny/zero `expires_in` cannot spin a hot loop.
const MIN_REFRESH_DELAY_IN_S = 1;

/**
 * The subset of the OIDC token-endpoint response this helper relies on. Keycloak returns more fields
 * (e.g. `token_type`, `scope`, `id_token`); only these are consumed here.
 *
 * @typedef {object} TokenResponse
 * @property {string} access_token
 *     The short-lived bearer token sent on each gRPC call.
 * @property {string} [refresh_token]
 *     The offline refresh token used to renew the access token. Present on the initial ROPC login and
 *     on each refresh that rotates the token; absent when Keycloak chooses not to rotate.
 * @property {number} [expires_in]
 *     Lifetime of `access_token` in seconds, used to schedule the next background refresh.
 */

/**
 * The minimal slice of a `fetch` Response this helper reads. Implementations (the real `globalThis.fetch`
 * or an injected stub) must expose at least these members.
 *
 * @typedef {object} FetchResponse
 * @property {boolean} ok
 *     Whether the HTTP status is in the 2xx range.
 * @property {number} status
 *     The HTTP status code, surfaced in the error message on a non-2xx response.
 * @property {() => Promise<string>} text
 *     Resolves to the raw response body, parsed as JSON by {@link postTokenRequest}.
 */

/**
 * The `fetch` init this helper sends: a POST with form-urlencoded headers and body. Typed precisely
 * (rather than the looser `RequestInit`) so an injected stub can read `init.body` for assertions while
 * still accepting the real `globalThis.fetch`, whose wider parameter type is a contravariant supertype.
 *
 * @typedef {{ method: string, headers: Record<string, string>, body: string }} FetchInit
 */

/**
 * A `fetch`-compatible function. Injected via the `fetchImpl` option so tests can mock the token
 * endpoint with no network access; defaults to `globalThis.fetch`.
 *
 * @typedef {(url: string, init: FetchInit) => Promise<FetchResponse>} FetchImpl
 */

/** Error raised on any token-endpoint or token-shape failure. */
class TokenError extends Error {
	/**
	 * @param {string} message
	 *     Human-readable description of the token failure.
	 */
	constructor(message) {
		super(message);
		/**
		 * Discriminator overriding the inherited `Error.name`, so callers can branch on `error.name`.
		 * @type {string}
		 */
		this.name = 'TokenError';
	}
}

/**
 * Build the OIDC token endpoint URL for a realm, tolerating a trailing slash on `keycloakUrl` and an
 * optional `/auth` relative path already baked into it.
 *
 * @param {string} keycloakUrl
 * @param {string} realm
 * @returns {string}
 */
function buildTokenEndpoint(keycloakUrl, realm) {
	const base = keycloakUrl.replace(/\/+$/, '');
	return `${base}/realms/${encodeURIComponent(realm)}/protocol/openid-connect/token`;
}

/**
 * POST an `application/x-www-form-urlencoded` body to the token endpoint and return the parsed JSON.
 * Raises TokenError on a non-2xx response or unparseable / access_token-less body.
 *
 * @param {string} tokenEndpoint
 *     The realm's OIDC token endpoint, as built by {@link buildTokenEndpoint}.
 * @param {Record<string, string>} params
 *     The form fields to URL-encode into the request body (e.g. `grant_type`, `client_id`).
 * @param {FetchImpl} fetchImpl
 *     The `fetch`-compatible function used to issue the request.
 * @returns {Promise<TokenResponse>}
 *     The parsed token-endpoint response, guaranteed to carry a non-empty `access_token`.
 * @throws {TokenError}
 *     On a non-2xx response, an unparseable body, or a body lacking an `access_token`.
 */
async function postTokenRequest(tokenEndpoint, params, fetchImpl) {
	const body = new URLSearchParams(params).toString();
	const response = await fetchImpl(tokenEndpoint, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			Accept: 'application/json'
		},
		body
	});
	const text = await response.text();
	if (!response.ok) {
		throw new TokenError(`Keycloak token endpoint returned HTTP ${response.status}: ${text}`);
	}
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new TokenError(`Keycloak token endpoint returned a non-JSON body: ${text}`);
	}
	if (typeof parsed.access_token !== 'string' || parsed.access_token.length === 0) {
		throw new TokenError('Keycloak token response did not contain an access_token');
	}
	return parsed;
}

/**
 * Construction-time options shared by {@link OfflineTokenProvider} and {@link login}. The `fetchImpl`
 * and `nowInMs` hooks exist so unit tests can drive the provider deterministically without network or
 * wall-clock access.
 *
 * @typedef {object} ProviderOptions
 * @property {string} keycloakUrl
 *     Base URL of the Keycloak server, optionally including an `/auth` path and/or a trailing slash.
 * @property {string} realm
 *     The Keycloak realm whose token endpoint to target.
 * @property {string} clientId
 *     The PUBLIC SDK client id (e.g. `ondewo-nlu-cai-sdk-public`); no client secret is ever sent.
 * @property {number} [tokenExpirationInS]
 *     Optional upper bound, in seconds since login, after which the background refresh loop stops and
 *     the access token is allowed to lapse (forcing a re-login). Unbounded when omitted.
 * @property {FetchImpl} [fetchImpl]
 *     Optional `fetch` override; defaults to `globalThis.fetch`.
 * @property {() => number} [nowInMs]
 *     Optional clock returning epoch milliseconds; defaults to `Date.now`.
 */

/**
 * A live access-token holder backed by a bounded auto-refresh loop. Obtain one from {@link login};
 * read {@link OfflineTokenProvider#getAuthorizationHeader} for the gRPC `Authorization` metadata and
 * call {@link OfflineTokenProvider#stop} when done.
 */
class OfflineTokenProvider {
	/**
	 * @param {ProviderOptions} options
	 *     The Keycloak connection options plus the optional test hooks.
	 */
	constructor(options) {
		/**
		 * The realm's OIDC token endpoint, computed once from `keycloakUrl` + `realm`.
		 * @type {string}
		 */
		this.tokenEndpoint = buildTokenEndpoint(options.keycloakUrl, options.realm);
		/**
		 * The PUBLIC SDK client id sent on every token request.
		 * @type {string}
		 */
		this.clientId = options.clientId;
		/**
		 * Optional bound, in seconds, on the lifetime of the refresh loop (undefined = unbounded).
		 * @type {number | undefined}
		 */
		this.tokenExpirationInS = options.tokenExpirationInS;
		/**
		 * The `fetch`-compatible function used for all token requests.
		 * @type {FetchImpl}
		 */
		this.fetchImpl = options.fetchImpl !== undefined ? options.fetchImpl : globalThis.fetch;
		/**
		 * The clock used for deadline computations, in epoch milliseconds.
		 * @type {() => number}
		 */
		this.nowInMs = options.nowInMs !== undefined ? options.nowInMs : Date.now;
		/**
		 * The current short-lived access token, or null before bootstrap / after the loop has lapsed.
		 * @type {string | null}
		 */
		this.accessToken = null;
		/**
		 * The current offline refresh token used to renew the access token, or null before bootstrap.
		 * @type {string | null}
		 */
		this.refreshToken = null;
		/**
		 * Handle of the pending single-shot refresh timer, or null when none is armed.
		 * @type {ReturnType<typeof setTimeout> | null}
		 */
		this.timer = null;
		/**
		 * Whether {@link OfflineTokenProvider#stop} has been called; gates all further refreshes.
		 * @type {boolean}
		 */
		this.stopped = false;
		/**
		 * Epoch-millisecond instant at which the refresh loop must stop, or null when unbounded.
		 * @type {number | null}
		 */
		this.deadlineInMs = null;
		/**
		 * Optional callback invoked with the error of a failed background refresh, or null when unset.
		 * @type {((error: unknown) => void) | null}
		 */
		this.onRefreshErrorHandler = null;
	}

	/**
	 * Perform the one-time ROPC login and arm the first refresh. Awaited by {@link login}.
	 *
	 * @param {string} username
	 *     The resource-owner username for the `grant_type=password` flow.
	 * @param {string} password
	 *     The resource-owner password for the `grant_type=password` flow.
	 * @returns {Promise<void>}
	 *     Resolves once the access/refresh tokens are stored and the first refresh is scheduled.
	 * @throws {TokenError}
	 *     When the token endpoint fails or the response carries no offline `refresh_token`.
	 */
	async bootstrap(username, password) {
		const tokenResponse = await postTokenRequest(
			this.tokenEndpoint,
			{
				grant_type: 'password',
				client_id: this.clientId,
				username,
				password,
				scope: 'offline_access'
			},
			this.fetchImpl
		);
		this.accessToken = tokenResponse.access_token;
		this.refreshToken = typeof tokenResponse.refresh_token === 'string' ? tokenResponse.refresh_token : null;
		if (this.refreshToken === null) {
			throw new TokenError(
				'Keycloak token response did not contain a refresh_token; the SDK client must have ' +
					'directAccessGrants + the offline_access scope (ondewo-nlu-cai-sdk-public)'
			);
		}
		if (this.tokenExpirationInS !== undefined) {
			const expirationInMs = this.tokenExpirationInS * 1000;
			this.deadlineInMs = this.nowInMs() + expirationInMs;
		}
		this.scheduleRefresh(tokenResponse.expires_in);
	}

	/**
	 * Exchange the offline refresh token for a fresh access token and re-arm the next refresh. Returns
	 * early without a network call when the provider is stopped or its bounded deadline has elapsed.
	 *
	 * @returns {Promise<void>}
	 *     Resolves once a fresh access token is stored and the next refresh is scheduled, or immediately
	 *     when the provider is stopped / lapsed.
	 * @throws {TokenError}
	 *     When the token endpoint fails or returns a body without an `access_token`.
	 */
	async refresh() {
		if (this.stopped) {
			return;
		}
		// Re-check the bounded deadline at fire time (not just at schedule time): once it has elapsed the
		// loop stops with no further renewal -> the access token lapses -> re-login is required.
		if (this.deadlineInMs !== null && this.nowInMs() >= this.deadlineInMs) {
			this.stop();
			return;
		}
		const tokenResponse = await postTokenRequest(
			this.tokenEndpoint,
			{
				grant_type: 'refresh_token',
				client_id: this.clientId,
				// Non-null here: refresh() only runs after bootstrap() stored an offline refresh token.
				refresh_token: /** @type {string} */ (this.refreshToken)
			},
			this.fetchImpl
		);
		this.accessToken = tokenResponse.access_token;
		// Keycloak may rotate the offline refresh token; keep the newest one when present.
		if (typeof tokenResponse.refresh_token === 'string' && tokenResponse.refresh_token.length > 0) {
			this.refreshToken = tokenResponse.refresh_token;
		}
		this.scheduleRefresh(tokenResponse.expires_in);
	}

	/**
	 * Arm a single timer for the next refresh, clamped to the bounded deadline. Stops silently once
	 * `tokenExpirationInS` has elapsed (no further renewal -> access lapses -> re-login required).
	 *
	 * @param {number | undefined} expiresInRaw
	 *     The access-token lifetime in seconds from the token response; clamped to
	 *     {@link MIN_REFRESH_DELAY_IN_S} when missing or non-positive.
	 * @returns {void}
	 */
	scheduleRefresh(expiresInRaw) {
		if (this.stopped) {
			return;
		}
		const expiresInS = typeof expiresInRaw === 'number' && expiresInRaw > 0 ? expiresInRaw : MIN_REFRESH_DELAY_IN_S;
		let delayInS = Math.max(expiresInS - REFRESH_SKEW_IN_S, MIN_REFRESH_DELAY_IN_S);
		if (this.deadlineInMs !== null) {
			const remainingInMs = this.deadlineInMs - this.nowInMs();
			if (remainingInMs <= 0) {
				this.stop();
				return;
			}
			delayInS = Math.min(delayInS, remainingInMs / 1000);
		}
		this.timer = setTimeout(() => {
			this.refresh().catch((refreshError) => {
				// Swallow a transient refresh failure but surface it so the caller can react; the next
				// gRPC call gets the stale (possibly expired) token and re-logs in on UNAUTHENTICATED.
				if (this.onRefreshErrorHandler !== null) {
					this.onRefreshErrorHandler(refreshError);
				}
			});
		}, delayInS * 1000);
		// Do not keep the event loop alive solely for the refresh timer.
		// c8 ignore next -- defensive: Node's real setTimeout always returns a Timeout exposing unref(); the
		// non-function branch is unreachable here and only guards against exotic non-Node shims.
		if (typeof this.timer.unref === 'function') {
			this.timer.unref();
		}
	}

	/**
	 * Register a callback invoked with the error of a failed background refresh (optional diagnostics).
	 *
	 * @param {(error: unknown) => void} handler
	 *     Called with the rejection reason of a failed refresh; replaces any previously registered handler.
	 * @returns {void}
	 */
	onRefreshError(handler) {
		this.onRefreshErrorHandler = handler;
	}

	/**
	 * The current access token, or null before bootstrap / after the bounded loop has lapsed.
	 *
	 * @returns {string | null}
	 *     The live access token, or null when none is available yet.
	 */
	getAccessToken() {
		return this.accessToken;
	}

	/**
	 * The value for an `Authorization` gRPC metadata header: `Bearer <access_token>`.
	 *
	 * @returns {string}
	 *     The `Bearer <access_token>` header value.
	 * @throws {TokenError}
	 *     When no access token is available (login has not completed or has lapsed).
	 */
	getAuthorizationHeader() {
		if (this.accessToken === null) {
			throw new TokenError('No access token available; login() has not completed or has lapsed');
		}
		return `Bearer ${this.accessToken}`;
	}

	/**
	 * Stop the auto-refresh loop. Idempotent; safe to call from any state.
	 *
	 * @returns {void}
	 */
	stop() {
		this.stopped = true;
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}
}

/**
 * Options accepted by {@link login}: the shared {@link ProviderOptions} plus the resource-owner
 * credentials for the one-time ROPC password grant.
 *
 * @typedef {ProviderOptions & { username: string, password: string }} LoginOptions
 */

/**
 * One-time ROPC + offline_access login against the PUBLIC SDK client, returning a live token provider
 * whose access token is auto-refreshed in the background until `tokenExpirationInS` elapses.
 *
 * @param {LoginOptions} options
 *     The Keycloak connection options plus the `username`/`password` credentials.
 * @returns {Promise<OfflineTokenProvider>}
 *     A provider whose first access token is already populated and whose refresh loop is armed.
 * @throws {TokenError}
 *     When `options` is missing, a required string option is empty, or the login request fails.
 */
async function login(options) {
	if (options === undefined || options === null) {
		throw new TokenError('login() requires an options object');
	}
	/** @type {('keycloakUrl' | 'realm' | 'clientId' | 'username' | 'password')[]} */
	const requiredKeys = ['keycloakUrl', 'realm', 'clientId', 'username', 'password'];
	for (const key of requiredKeys) {
		const value = options[key];
		if (typeof value !== 'string' || value.length === 0) {
			throw new TokenError(`login() option "${key}" is required and must be a non-empty string`);
		}
	}
	const provider = new OfflineTokenProvider(options);
	await provider.bootstrap(options.username, options.password);
	return provider;
}

module.exports = { TokenError, OfflineTokenProvider, login };
