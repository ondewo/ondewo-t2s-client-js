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

// D18 headless-SDK auth helper (keycloak-migration-plan §7.8 + D18), implementing the cross-language
// "ONDEWO client SDK Keycloak token handling" specification. The python SDKs are the canonical source;
// every constant, message and decision below is kept identical to theirs.
//
// Start-up is ONE token request against the PUBLIC SDK client `ondewo-nlu-cai-sdk-public` (no
// client_secret -- Q1): either a handed-off OFFLINE refresh token (`refreshToken`, a refresh grant, never a
// password grant) or a one-time ROPC login (grant_type=password, scope=offline_access). The short-lived
// access token is then kept fresh two ways, both sharing ONE jittered failure backoff:
//
// - proactively, by a background loop that wakes 30 s before expiry (a `setTimeout` chain, unref-ed);
// - lazily, by `getAuthorizationMetadata()`, which every gRPC call can await (see
//   `createAuthUnaryInterceptor`).
//
// A failed refresh never ends the loop and never falls back to a password grant. While the current token
// is still valid it keeps being served; only an EXPIRED token whose refresh fails raises
// `KeycloakAuthenticationError`. The loop stops after `tokenExpirationInS` (if given) has elapsed since
// the first token was acquired.

'use strict';

/* global require, URLSearchParams, setTimeout, clearTimeout, module, performance, AbortController, TextEncoder */

/**
 * A minimal structural subset of the WHATWG `Response` consumed by this module: the success flag, the
 * HTTP status, and a `text()` reader. Modelled explicitly (rather than reusing the DOM `Response`) so
 * that the injectable {@link FetchImpl} stub used by the tests satisfies the same contract.
 *
 * @typedef {object} FetchResponse
 * @property {boolean} ok
 *   Whether the HTTP status is in the 2xx range.
 * @property {number} status
 *   The numeric HTTP status code.
 * @property {() => Promise<string>} text
 *   Resolves the response body as a string.
 */

/**
 * An opaque undici dispatcher (a connection pool). Only ever created and passed through by this module,
 * never inspected, so its shape is deliberately not modelled.
 *
 * @typedef {object} Dispatcher
 */

/**
 * The `fetch` init object this module builds for the token endpoint: a form-encoded POST bounded by an
 * abort signal, plus the optional undici `dispatcher` that disables TLS certificate verification (see
 * {@link getInsecureDispatcher}).
 *
 * @typedef {object} TokenRequestInit
 * @property {string} method
 *   The HTTP method; always `'POST'`.
 * @property {Record<string, string>} headers
 *   The request headers (`Content-Type`, `Accept`).
 * @property {string} body
 *   The URL-encoded form body carrying the grant parameters.
 * @property {AbortSignal} signal
 *   Aborts the whole exchange (connect + body read) after `keycloakTiming.httpTimeoutInS`.
 * @property {Dispatcher} [dispatcher]
 *   Present only when `keycloakVerifySsl === false`; honoured by the real global fetch (Node/undici) and
 *   ignored by an injected {@link FetchImpl} and by every browser.
 */

/**
 * The `fetch`-shaped function used to call the Keycloak token endpoint. Injectable so tests can supply
 * a hermetic stub; defaults to `globalThis.fetch` at runtime.
 *
 * @typedef {(url: string, init: TokenRequestInit) => Promise<FetchResponse>} FetchImpl
 */

/**
 * The logger the provider reports refresh failures and recoveries through. Every method receives one
 * already-formatted line that never contains a credential. Defaults to `console`.
 *
 * @typedef {object} KeycloakLogger
 * @property {(message: string) => void} warn
 *   Receives exactly one line per failed refresh.
 * @property {(message: string) => void} info
 *   Receives the one line logged when a refresh recovers after failures.
 * @property {(message: string) => void} debug
 *   Receives the background loop's note that an already-reported failure will be retried.
 */

/**
 * The interruptible wait the background loop sleeps on. Resolves `true` when the provider was stopped
 * during the wait (the loop then exits without another request) and `false` when the delay elapsed.
 * Injectable so tests can drive the loop with a fake clock and no real sleep.
 *
 * @typedef {(delayInS: number) => Promise<boolean>} WaitImpl
 */

/**
 * The options accepted by {@link login}, {@link getKeycloakTokenProvider} and the
 * {@link OfflineTokenProvider} constructor. `login` additionally requires the credential fields; the
 * constructor only consumes the connection, handed-off token and injectable-dependency fields.
 *
 * @typedef {object} LoginOptions
 * @property {string} keycloakUrl
 *   The Keycloak base URL, the part before `/realms/<realm>` (a trailing slash is tolerated).
 * @property {string} realm
 *   The Keycloak realm whose token endpoint is targeted.
 * @property {string} clientId
 *   The PUBLIC SDK client id (`ondewo-nlu-cai-sdk-public`); no client_secret is sent.
 * @property {string} username
 *   The resource-owner username for the ROPC password grant. It must be a 2FA-exempt technical user
 *   (create one with `Agents.CreateProjectTechnicalUser` and pass the returned `username`, not an
 *   e-mail): a non-interactive password grant cannot answer an OTP challenge.
 * @property {string} [password]
 *   The resource-owner password for the ROPC password grant. Optional when `refreshToken` is given.
 * @property {string} [refreshToken]
 *   A handed-off Keycloak OFFLINE refresh token used INSTEAD of the password: start-up is one refresh
 *   grant with it, and no password grant is ever sent, not even as a fallback when it is refused.
 * @property {number} [tokenExpirationInS]
 *   Optional bound, in seconds since the first token was acquired, after which the refresh stops.
 * @property {FetchImpl} [fetchImpl]
 *   Optional `fetch` override; defaults to `globalThis.fetch`.
 * @property {() => number} [randomFraction]
 *   Optional [0,1) random source for the failure-backoff jitter; defaults to `Math.random`. Consulted
 *   only on the failure path. Injected for deterministic tests.
 * @property {() => number} [nowInMs]
 *   Optional MONOTONIC clock in milliseconds; defaults to `performance.now` (overridable for tests).
 * @property {boolean} [keycloakVerifySsl]
 *   TLS certificate verification for the Keycloak token-endpoint call; defaults to `true` (secure). Set
 *   `false` only for a self-signed local Envoy (e.g. `https://localhost:12001/auth`). Node-only: when
 *   `false`, an undici dispatcher with `rejectUnauthorized: false` is attached to the token request. A
 *   browser cannot honour it (it always verifies), and it is a no-op for an injected `fetchImpl`.
 * @property {KeycloakLogger} [logger]
 *   Optional logger for the refresh warnings; defaults to `console`.
 * @property {WaitImpl} [waitImpl]
 *   Optional test seam replacing the background loop's interruptible `setTimeout` wait.
 * @property {boolean} [startBackgroundRefresh]
 *   Test seam: `false` skips the proactive background loop (the lazy path still refreshes).
 */

/**
 * The parsed and validated content of one token response.
 *
 * @typedef {object} ParsedTokens
 * @property {string} accessToken
 *   The new access token (always non-empty).
 * @property {string | null} refreshToken
 *   The rotated refresh token, or `null` when the response carried none.
 * @property {number} expiresInS
 *   The access token lifetime in seconds (0 when absent).
 */

/**
 * The timing constants of the specification. Identical in every ONDEWO SDK; tests shrink a copy through
 * {@link keycloakTiming}, never this frozen original.
 *
 * - `expiryLeewayInS`: refresh this long before the access token expires.
 * - `minRefreshDelayInS`: floor of any background wait (no hot loop on `expires_in` 0).
 * - `retryBaseDelayInS`: first retry after a failure; far above the floor, so an outage is never a 1 Hz
 *   poll per client -- ondewo runs one client per call container, against one shared realm.
 * - `retryMaxDelayInS`: backoff ceiling.
 * - `maxRetryExponent`: `5 * 2^6 = 320 >= 300`; caps the exponent so it cannot overflow.
 * - `httpTimeoutInS`: the whole token-endpoint call (connect + read); must stay below the leeway.
 * - `maxErrorBodyChars`: an error body is quoted up to this many characters.
 * - `closeTimeoutInS`: how long {@link OfflineTokenProvider#close} waits for the background loop.
 *
 * @type {Readonly<{ expiryLeewayInS: number, minRefreshDelayInS: number, retryBaseDelayInS: number,
 *   retryMaxDelayInS: number, maxRetryExponent: number, httpTimeoutInS: number, maxErrorBodyChars: number,
 *   closeTimeoutInS: number }>}
 */
const KEYCLOAK_TIMING_DEFAULTS = Object.freeze({
	expiryLeewayInS: 30,
	minRefreshDelayInS: 1,
	retryBaseDelayInS: 5,
	retryMaxDelayInS: 300,
	maxRetryExponent: 6,
	httpTimeoutInS: 10,
	maxErrorBodyChars: 500,
	closeTimeoutInS: 5
});

/**
 * The timing constants actually used, read at every use. A test seam: tests may shrink these and must
 * restore them from {@link KEYCLOAK_TIMING_DEFAULTS}; production code never writes to it.
 *
 * @type {{ expiryLeewayInS: number, minRefreshDelayInS: number, retryBaseDelayInS: number,
 *   retryMaxDelayInS: number, maxRetryExponent: number, httpTimeoutInS: number, maxErrorBodyChars: number,
 *   closeTimeoutInS: number }}
 */
const keycloakTiming = { ...KEYCLOAK_TIMING_DEFAULTS };

/**
 * The longest delay `setTimeout` honours (2^31 - 1 ms, ~24.8 days). A longer one fires after 1 ms, so a
 * huge `expires_in` would otherwise turn the background loop into a hot loop; the loop re-computes its
 * delay when a capped wait ends, so capping costs nothing.
 *
 * @type {number}
 */
const MAX_TIMER_DELAY_IN_MS = 2147483647;

/**
 * What every logging view renders in place of a non-empty secret.
 *
 * @constant
 * @type {string}
 */
const REDACTED = '***REDACTED***';

/**
 * Error raised for unusable options (and kept as the base class of every token failure, so code written
 * against earlier releases that catches `TokenError` keeps catching everything it caught before).
 */
class TokenError extends Error {
	/**
	 * Build a failure carrying a human-readable description and, optionally, its cause.
	 *
	 * @param {string} message
	 *   The human-readable failure description. Never contains a credential.
	 * @param {{ cause?: unknown }} [options]
	 *   The standard `Error` options; `cause` is the underlying error, reachable as `error.cause`.
	 */
	constructor(message, options) {
		super(message, options);
		/**
		 * The error name, used by consumers that discriminate on `error.name` rather than `instanceof`.
		 * @type {string}
		 */
		this.name = 'TokenError';
	}
}

/**
 * The ONE error type of every failed login, refresh or read of an expired token. The underlying error,
 * if any, is reachable as `error.cause`. Its message never contains a password, a refresh token or an
 * access token. A subclass of {@link TokenError}, so existing `catch (e) { if (e instanceof TokenError) }`
 * code keeps working.
 */
class KeycloakAuthenticationError extends TokenError {
	/**
	 * Build a token failure carrying a human-readable description and, optionally, its cause.
	 *
	 * @param {string} message
	 *   The human-readable failure description. Never contains a credential.
	 * @param {{ cause?: unknown }} [options]
	 *   The standard `Error` options; `cause` is the underlying error.
	 */
	constructor(message, options) {
		super(message, options);
		this.name = 'KeycloakAuthenticationError';
	}
}

/**
 * Render an error as `<ErrType>: <message>` for a log line or a wrapping error's message. A `fetch`
 * network failure is `TypeError: fetch failed` with the real reason (`ECONNREFUSED`, a DNS failure) in
 * its `cause`, so a cause's message is appended.
 *
 * @param {unknown} error
 *   The error to describe.
 * @returns {string}
 *   `<ErrType>: <message>`.
 */
function describeError(error) {
	if (!(error instanceof Error)) {
		return `${typeof error}: ${String(error)}`;
	}
	/**
	 * The cause of the error, if it carries one.
	 * @type {unknown}
	 */
	const cause = error.cause;
	/**
	 * The cause's message appended to the error's own, or nothing when it has no Error cause.
	 * @type {string}
	 */
	const causeSuffix = cause instanceof Error ? ` (${cause.message})` : '';
	return `${error.name}: ${error.message}${causeSuffix}`;
}

/**
 * Build the OIDC token endpoint URL for a realm, tolerating trailing slashes on `keycloakUrl`.
 *
 * @param {string} keycloakUrl
 *   The Keycloak base URL; a trailing slash is tolerated.
 * @param {string} realm
 *   The realm whose token endpoint is targeted; URL-encoded into the path.
 * @returns {string}
 *   The fully-qualified OIDC token endpoint for that realm.
 */
function buildTokenEndpoint(keycloakUrl, realm) {
	/**
	 * The base URL with any trailing slashes stripped, so the path can be appended unconditionally.
	 * @type {string}
	 */
	const base = keycloakUrl.replace(/\/+$/, '');
	return `${base}/realms/${encodeURIComponent(realm)}/protocol/openid-connect/token`;
}

/**
 * The undici `Agent` options that switch TLS certificate verification OFF for the token request. Exported
 * so the security-relevant `rejectUnauthorized: false` literal is pinned by a test rather than living as a
 * bare literal that could be flipped without any test noticing.
 *
 * @type {{ connect: { rejectUnauthorized: boolean } }}
 */
const INSECURE_AGENT_OPTIONS = { connect: { rejectUnauthorized: false } };

/**
 * Lazily-created, cached undici `Agent` that skips TLS certificate verification. Built only when the
 * insecure code path is first taken (`keycloakVerifySsl === false`), so `undici` is never required in the
 * common secure path.
 *
 * @type {Dispatcher | null}
 */
let insecureDispatcher = null;

/**
 * Return a cached undici dispatcher (`Agent`) configured with `rejectUnauthorized: false`, lazily
 * requiring `undici` on first use. Scoped to the token request only, so it does not weaken the separate
 * gRPC-web TLS, and never a process-wide switch such as `NODE_TLS_REJECT_UNAUTHORIZED`.
 *
 * @returns {Dispatcher}
 *   The insecure undici `Agent` dispatcher.
 */
function getInsecureDispatcher() {
	if (insecureDispatcher === null) {
		// undici is required lazily so the dependency is only loaded on the insecure path.
		const { Agent } = require('undici');
		insecureDispatcher = new Agent(INSECURE_AGENT_OPTIONS);
	}
	return insecureDispatcher;
}

/**
 * Name the JSON type of a parsed body that is not an object, for the "instead of an object" error.
 *
 * @param {unknown} value
 *   The parsed JSON value.
 * @returns {string}
 *   `array`, `null`, `string`, `number` or `boolean`.
 */
function jsonTypeName(value) {
	if (Array.isArray(value)) {
		return 'array';
	}
	return value === null ? 'null' : typeof value;
}

/**
 * POST an `application/x-www-form-urlencoded` body to the token endpoint and return the parsed JSON
 * object. Every way the exchange can fail surfaces as {@link KeycloakAuthenticationError}, with the
 * original error as its `cause`: the endpoint cannot be reached (refused, DNS, TLS, the
 * `keycloakTiming.httpTimeoutInS` timeout), a non-2xx status, a body that is not JSON, and a JSON body
 * that is not an object. No message ever contains the form (which carries the credential).
 *
 * @param {string} tokenEndpoint
 *   The fully-qualified OIDC token endpoint (see {@link buildTokenEndpoint}).
 * @param {Record<string, string>} params
 *   The form fields to URL-encode into the request body.
 * @param {FetchImpl} fetchImpl
 *   The `fetch`-shaped function used to perform the request.
 * @param {boolean} verifySsl
 *   When `false`, attach an insecure undici dispatcher to the request (Node's global fetch only).
 * @param {string} action
 *   `login` (password grant) or `refresh` (refresh grant), for the error messages.
 * @returns {Promise<Record<string, unknown>>}
 *   The parsed token response object.
 * @throws {KeycloakAuthenticationError}
 *   On any failure of the exchange.
 */
async function postTokenRequest(tokenEndpoint, params, fetchImpl, verifySsl, action) {
	/**
	 * Aborts the exchange once the HTTP timeout elapses.
	 * @type {AbortController}
	 */
	const abortController = new AbortController();
	/**
	 * The request descriptor handed to `fetchImpl`.
	 * @type {TokenRequestInit}
	 */
	const init = {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			Accept: 'application/json'
		},
		body: new URLSearchParams(params).toString(),
		signal: abortController.signal
	};
	if (verifySsl === false) {
		init.dispatcher = getInsecureDispatcher();
	}
	/**
	 * The timer that aborts a hanging exchange.
	 * @type {ReturnType<typeof setTimeout>}
	 */
	const timeoutTimer = setTimeout(() => {
		abortController.abort();
	}, keycloakTiming.httpTimeoutInS * 1000);
	unrefTimer(timeoutTimer);
	/** @type {FetchResponse} */
	let response;
	/**
	 * The raw response body, read inside the timeout so a stalled body is bounded too.
	 * @type {string}
	 */
	let text;
	try {
		response = await fetchImpl(tokenEndpoint, init);
		text = await response.text();
	} catch (error) {
		throw new KeycloakAuthenticationError(
			`Keycloak token ${action} could not reach the token endpoint (${describeError(error)})`,
			{ cause: error }
		);
	} finally {
		clearTimeout(timeoutTimer);
	}
	if (response.status < 200 || response.status >= 300) {
		throw new KeycloakAuthenticationError(
			`Keycloak token ${action} failed with status ${response.status}: ${text.slice(0, keycloakTiming.maxErrorBodyChars)}`
		);
	}
	/** @type {unknown} */
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new KeycloakAuthenticationError(
			`Keycloak token ${action} returned status ${response.status} with a body that is not JSON`,
			{ cause: error }
		);
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new KeycloakAuthenticationError(
			`Keycloak token ${action} returned a JSON ${jsonTypeName(parsed)} instead of an object`
		);
	}
	return /** @type {Record<string, unknown>} */ (parsed);
}

/**
 * Validate a token response WITHOUT assigning anything, so a malformed response changes no state.
 *
 * @param {Record<string, unknown>} payload
 *   The parsed token endpoint response.
 * @returns {ParsedTokens}
 *   The validated access token, the rotated refresh token (or `null`) and the lifetime.
 * @throws {KeycloakAuthenticationError}
 *   When there is no usable `access_token` or `expires_in` is not numeric. The message names the
 *   response's FIELD NAMES only, never a value: a token response is made almost entirely of credentials.
 */
function parseTokenPayload(payload) {
	/** @type {unknown} */
	const accessToken = payload.access_token;
	if (typeof accessToken !== 'string' || accessToken.length === 0) {
		/**
		 * The response's field names, sorted, rendered as a list (values withheld).
		 * @type {string}
		 */
		const fieldNames = Object.keys(payload)
			.sort()
			.map((name) => `'${name}'`)
			.join(', ');
		throw new KeycloakAuthenticationError(
			'Keycloak token response did not contain an access_token; the response carried ' +
				`the fields [${fieldNames}] (values withheld: a token response is credential material)`
		);
	}
	/** @type {unknown} */
	const rawExpiresIn = payload.expires_in;
	/**
	 * The lifetime in seconds: absent means 0, a number or a numeric string is accepted.
	 * @type {number}
	 */
	let expiresInS = 0;
	if (rawExpiresIn !== undefined) {
		expiresInS =
			typeof rawExpiresIn === 'number' || (typeof rawExpiresIn === 'string' && rawExpiresIn.trim() !== '')
				? Number(rawExpiresIn)
				: Number.NaN;
		if (Number.isNaN(expiresInS)) {
			throw new KeycloakAuthenticationError(
				'Keycloak token response carried a non-numeric expires_in (value withheld)'
			);
		}
	}
	/** @type {unknown} */
	const rotated = payload.refresh_token;
	return {
		accessToken,
		refreshToken: typeof rotated === 'string' && rotated.length > 0 ? rotated : null,
		expiresInS
	};
}

/**
 * The wait before the next attempt after `consecutiveFailures` failed refreshes: full jitter in
 * `[base, ceiling]`, the ceiling doubling from `retryBaseDelayInS` up to `retryMaxDelayInS`. The jitter
 * is the load-bearing half: N call containers whose refreshes fail in the same instant would otherwise
 * retry in lockstep for as long as the outage lasts.
 *
 * @param {number} consecutiveFailures
 *   Consecutive failed refreshes; values below 1 (and NaN) are treated as 1, a huge value cannot overflow.
 * @param {() => number} randomFraction
 *   A [0,1) source; an out-of-range or NaN value is clamped, so the delay never leaves the window.
 * @returns {number}
 *   Seconds to wait before the next refresh attempt.
 */
function backoffDelayInS(consecutiveFailures, randomFraction) {
	/** @type {number} */
	const failures = Number.isNaN(consecutiveFailures) ? 1 : Math.max(consecutiveFailures, 1);
	/** @type {number} */
	const exponent = Math.min(failures - 1, keycloakTiming.maxRetryExponent);
	/** @type {number} */
	const ceilingInS = Math.min(keycloakTiming.retryBaseDelayInS * 2 ** exponent, keycloakTiming.retryMaxDelayInS);
	/** @type {number} */
	const raw = randomFraction();
	/** @type {number} */
	const fraction = Number.isNaN(raw) ? 0 : Math.min(Math.max(raw, 0), 1);
	return keycloakTiming.retryBaseDelayInS + fraction * (ceilingInS - keycloakTiming.retryBaseDelayInS);
}

/**
 * Detach a Node timer from the event loop so it never keeps the process alive. A browser's numeric
 * handle has no `unref`, hence the guard.
 *
 * @param {ReturnType<typeof setTimeout>} timer
 *   The timer handle.
 * @returns {void}
 */
function unrefTimer(timer) {
	/** @type {{ unref?: unknown }} */
	const handle = /** @type {any} */ (timer);
	if (typeof handle.unref === 'function') {
		/** @type {() => void} */ (handle.unref).call(timer);
	}
}

/**
 * The stop switch shared by a provider and its background loop. It deliberately holds NO reference to the
 * provider, so a pending wait cannot keep a provider alive (the loop holds the provider only weakly).
 */
class StopSignal {
	constructor() {
		/**
		 * Latched by {@link StopSignal#fire}.
		 * @type {boolean}
		 */
		this.stopped = false;
		/**
		 * Ends the pending wait early, or `null` when none is pending.
		 * @type {(() => void) | null}
		 */
		this.cancelPendingWait = null;
	}

	/**
	 * Sleep `delayInS` on a real, unref-ed timer, ending early (resolving `true`) when the signal fires.
	 *
	 * @param {number} delayInS
	 *   Seconds to wait; capped at the longest delay `setTimeout` honours.
	 * @returns {Promise<boolean>}
	 *   `true` when stopped during (or before) the wait, `false` when the delay elapsed.
	 */
	wait(delayInS) {
		if (this.stopped) {
			return Promise.resolve(true);
		}
		return new Promise((resolve) => {
			/** @type {ReturnType<typeof setTimeout>} */
			const timer = setTimeout(
				() => {
					this.cancelPendingWait = null;
					resolve(false);
				},
				Math.min(delayInS * 1000, MAX_TIMER_DELAY_IN_MS)
			);
			unrefTimer(timer);
			this.cancelPendingWait = () => {
				clearTimeout(timer);
				resolve(true);
			};
		});
	}

	/**
	 * Latch the stop and end a pending wait at once, so no further request is sent. Idempotent.
	 *
	 * @returns {void}
	 */
	fire() {
		this.stopped = true;
		/** @type {(() => void) | null} */
		const cancel = this.cancelPendingWait;
		this.cancelPendingWait = null;
		if (cancel !== null) {
			cancel();
		}
	}
}

/**
 * The proactive background loop. It wakes `expiryLeewayInS` before the access token expires -- or, after
 * a failed refresh, when the shared backoff allows the next attempt -- and refreshes under the provider's
 * lock. A failure NEVER ends the loop: it was already counted, backed off and warned about by the
 * provider, so it is only noted at debug level here. The loop ends when the provider is stopped, the
 * `tokenExpirationInS` deadline passes, or the provider was garbage-collected (it is held only weakly).
 *
 * @param {{ deref: () => (OfflineTokenProvider | undefined) }} providerRef
 *   A weak reference to the provider; the loop exits when it derefs to `undefined`.
 * @param {StopSignal} stopSignal
 *   The provider's stop switch.
 * @param {WaitImpl} waitImpl
 *   The interruptible wait.
 * @param {() => number} nowInMs
 *   The monotonic clock in milliseconds.
 * @param {KeycloakLogger} logger
 *   Where the debug note goes.
 * @returns {Promise<void>}
 *   Resolves when the loop has exited.
 */
async function runRefreshLoop(providerRef, stopSignal, waitImpl, nowInMs, logger) {
	while (!stopSignal.stopped) {
		/** @type {OfflineTokenProvider | undefined} */
		let provider = providerRef.deref();
		if (provider === undefined) {
			return;
		}
		/** @type {number} */
		const nowInS = nowInMs() / 1000;
		/** @type {number | null} */
		const deadlineInS = provider.deadlineInS;
		if (deadlineInS !== null && nowInS >= deadlineInS) {
			// The bounded window has closed: stop renewing and let the token lapse.
			provider.stop();
			return;
		}
		/** @type {number} */
		let delayInS = provider.expiresAtInS - keycloakTiming.expiryLeewayInS - nowInS;
		if (provider.consecutiveRefreshFailures > 0) {
			// A failed refresh leaves the expiry unchanged, so the computation above would retry at the
			// floor for the whole outage. Wait for the backoff instead.
			delayInS = provider.nextRefreshAttemptAtInS - nowInS;
		}
		delayInS = Math.max(delayInS, keycloakTiming.minRefreshDelayInS);
		if (deadlineInS !== null) {
			delayInS = Math.min(delayInS, deadlineInS - nowInS);
		}
		// Drop the strong reference before sleeping so a long wait cannot pin the provider.
		provider = undefined;
		if ((await waitImpl(delayInS)) || stopSignal.stopped) {
			return;
		}
		provider = providerRef.deref();
		if (provider === undefined) {
			return;
		}
		/** @type {OfflineTokenProvider} */
		const current = provider;
		try {
			await current.withLock(() => current.refreshIfWithinWindow(nowInMs() / 1000));
		} catch (error) {
			logger.debug(`Keycloak background refresh will be retried (${describeError(error)})`);
		}
		provider = undefined;
	}
}

/**
 * A live access-token holder backed by a bounded, failure-tolerant auto-refresh. Obtain one from
 * {@link login} or {@link getKeycloakTokenProvider}; await
 * {@link OfflineTokenProvider#getAuthorizationMetadata} (or use {@link createAuthUnaryInterceptor}) for
 * the gRPC `authorization` metadata, and call {@link OfflineTokenProvider#stop} (or `await close()`) when
 * done.
 */
class OfflineTokenProvider {
	/**
	 * @param {LoginOptions} options
	 *   The connection, handed-off token and injectable-dependency options. The password is never read or
	 *   stored here; it is passed to {@link OfflineTokenProvider#bootstrap}.
	 */
	constructor(options) {
		/**
		 * The fully-qualified OIDC token endpoint for the configured realm.
		 * @type {string}
		 */
		this.tokenEndpoint = buildTokenEndpoint(options.keycloakUrl, options.realm);
		/**
		 * The PUBLIC SDK client id sent on every token request.
		 * @type {string}
		 */
		this.clientId = options.clientId;
		/**
		 * Optional bound (seconds since the first token) after which refresh stops; `undefined` = unbounded.
		 * @type {number | undefined}
		 */
		this.tokenExpirationInS = options.tokenExpirationInS;
		/**
		 * The `fetch`-shaped function used for token requests.
		 * @type {FetchImpl}
		 */
		this.fetchImpl = options.fetchImpl !== undefined ? options.fetchImpl : globalThis.fetch;
		/**
		 * The monotonic clock in milliseconds (overridable for tests).
		 * @type {() => number}
		 */
		this.nowInMs = options.nowInMs !== undefined ? options.nowInMs : () => performance.now();
		/** @type {() => number} The [0,1) random source used for the failure-backoff jitter. */
		this.randomFraction = options.randomFraction !== undefined ? options.randomFraction : Math.random;
		/**
		 * Whether to verify the Keycloak TLS certificate on the token call (secure default).
		 * @type {boolean}
		 */
		this.verifySsl = options.keycloakVerifySsl !== false;
		/**
		 * Where refresh failures and recoveries are reported.
		 * @type {KeycloakLogger}
		 */
		this.logger = options.logger !== undefined ? options.logger : console;
		/**
		 * Whether {@link OfflineTokenProvider#bootstrap} starts the proactive background loop.
		 * @type {boolean}
		 */
		this.startBackgroundRefresh = options.startBackgroundRefresh !== false;
		/**
		 * The current access token; `null` before {@link OfflineTokenProvider#bootstrap} completes.
		 * @type {string | null}
		 */
		this.accessToken = null;
		/**
		 * The current offline refresh token: the handed-off one until bootstrap, then the newest one.
		 * @type {string | null}
		 */
		this.refreshToken =
			typeof options.refreshToken === 'string' && options.refreshToken.length > 0 ? options.refreshToken : null;
		/**
		 * The monotonic time (seconds) at which the current access token expires.
		 * @type {number}
		 */
		this.expiresAtInS = 0;
		/**
		 * The bounded-refresh deadline (monotonic seconds), or `null` when unbounded.
		 * @type {number | null}
		 */
		this.deadlineInS = null;
		/**
		 * Consecutive failed refreshes, shared by the lazy path and the background loop.
		 * @type {number}
		 */
		this.consecutiveRefreshFailures = 0;
		/**
		 * The monotonic time (seconds) before which no refresh request is sent after a failure.
		 * @type {number}
		 */
		this.nextRefreshAttemptAtInS = 0;
		/**
		 * Whether {@link OfflineTokenProvider#stop} has been called (or the bounded window closed).
		 * @type {boolean}
		 */
		this.stopped = false;
		/**
		 * The stop switch of the background loop; holds no reference to this provider.
		 * @type {StopSignal}
		 */
		this.stopSignal = new StopSignal();
		/**
		 * The stop switch again, as a local: the default wait below must close over IT and not over
		 * `this`, or the pending wait would keep the provider alive and the weak loop reference moot.
		 * @type {StopSignal}
		 */
		const stopSignal = this.stopSignal;
		/**
		 * The background loop's interruptible wait (the real timer unless a test injected one).
		 * @type {WaitImpl}
		 */
		this.waitImpl = options.waitImpl !== undefined ? options.waitImpl : (delayInS) => stopSignal.wait(delayInS);
		/**
		 * The running background loop, or `null` when none was started.
		 * @type {Promise<void> | null}
		 */
		this.loopPromise = null;
		/**
		 * The tail of the lock queue: every refresh decision runs after the previous one settled, so N
		 * concurrent callers during an outage cause exactly ONE token request.
		 * @type {Promise<void>}
		 */
		this.lockTail = Promise.resolve();
		/**
		 * Optional callback invoked with the error of every failed refresh.
		 * @type {((error: unknown) => void) | null}
		 */
		this.onRefreshErrorHandler = null;
	}

	/**
	 * Acquire the first access token, arm the `tokenExpirationInS` deadline and start the background loop.
	 * Awaited by {@link login}. With a handed-off `refreshToken` this is ONE refresh grant and never a
	 * password grant, whatever the password holds and whatever the outcome; otherwise ONE password grant.
	 * A failure is raised as is: no retry, no fallback, no loop started.
	 *
	 * @param {string} username
	 *   The resource-owner username for the password grant (unused on the handed-off-token path).
	 * @param {string | undefined} password
	 *   The resource-owner password for the password grant (never sent on the handed-off-token path).
	 * @returns {Promise<void>}
	 *   Resolves once the initial tokens are stored and the loop is running.
	 * @throws {KeycloakAuthenticationError}
	 *   On a failed token request, or when a password login yields no usable `refresh_token` (the SDK
	 *   client lacks directAccessGrants + the offline_access scope).
	 */
	async bootstrap(username, password) {
		/** @type {boolean} */
		const viaHandedOffToken = this.refreshToken !== null;
		/** @type {Record<string, string>} */
		const params = viaHandedOffToken
			? {
					grant_type: 'refresh_token',
					client_id: this.clientId,
					refresh_token: /** @type {string} */ (this.refreshToken)
				}
			: {
					grant_type: 'password',
					client_id: this.clientId,
					username,
					password: password === undefined ? '' : password,
					scope: 'offline_access'
				};
		/** @type {Record<string, unknown>} */
		const payload = await postTokenRequest(
			this.tokenEndpoint,
			params,
			this.fetchImpl,
			this.verifySsl,
			viaHandedOffToken ? 'refresh' : 'login'
		);
		/** @type {ParsedTokens} */
		const tokens = parseTokenPayload(payload);
		if (!viaHandedOffToken && tokens.refreshToken === null) {
			// A blank offline token would bootstrap a provider whose every renewal fails, turning a clear
			// login error into a silent expiry ~5 minutes later.
			throw new KeycloakAuthenticationError(
				'Keycloak token response did not contain a refresh_token; the SDK client must have ' +
					'directAccessGrants + the offline_access scope (ondewo-nlu-cai-sdk-public)'
			);
		}
		this.storeTokens(tokens);
		// Armed after the acquisition on BOTH paths, so the bound means the same with a handed-off token.
		if (this.tokenExpirationInS !== undefined) {
			this.deadlineInS = this.nowInS() + this.tokenExpirationInS;
		}
		if (this.startBackgroundRefresh) {
			this.startRefreshLoop();
		}
	}

	/**
	 * The monotonic time in seconds.
	 *
	 * @returns {number}
	 *   `nowInMs() / 1000`.
	 */
	nowInS() {
		return this.nowInMs() / 1000;
	}

	/**
	 * Start the background loop, holding this provider only weakly.
	 *
	 * @returns {void}
	 */
	startRefreshLoop() {
		/**
		 * The logger as a local, for the same reason as the default wait: nothing the loop's promise chain
		 * holds may reference `this`.
		 * @type {KeycloakLogger}
		 */
		const logger = this.logger;
		this.loopPromise = runRefreshLoop(new WeakRef(this), this.stopSignal, this.waitImpl, this.nowInMs, logger).catch(
			/**
			 * The loop catches every refresh failure itself; this only absorbs a broken injected seam
			 * (a rejecting `waitImpl` or a throwing clock), so it can never become an unhandledRejection.
			 * @param {unknown} error
			 *   The rejection.
			 * @returns {void}
			 */
			(error) => {
				logger.warn(`Keycloak background token refresh stopped unexpectedly (${describeError(error)})`);
			}
		);
	}

	/**
	 * Run `task` after every previously queued refresh decision has settled (an async mutex).
	 *
	 * @template T
	 * @param {() => Promise<T>} task
	 *   The critical section.
	 * @returns {Promise<T>}
	 *   The task's result.
	 */
	withLock(task) {
		/** @type {Promise<T>} */
		const run = this.lockTail.then(task);
		this.lockTail = run.then(
			() => undefined,
			() => undefined
		);
		return run;
	}

	/**
	 * Refresh the access token if it is near expiry, refresh is permitted and not backing off. Shared by
	 * the lazy path and the background loop; callers hold the lock ({@link OfflineTokenProvider#withLock}).
	 *
	 * A failed refresh is counted and backed off, and RAISED only once the current access token has
	 * actually expired: inside the leeway the token is still valid, so the call that triggered the refresh
	 * goes out with it. While the backoff runs no request is sent at all. Never a password grant.
	 *
	 * @param {number} nowInS
	 *   The current monotonic time in seconds.
	 * @returns {Promise<void>}
	 *   Resolves when the current token may be served.
	 * @throws {KeycloakAuthenticationError}
	 *   When the access token has expired and could not be refreshed, now or because of the backoff.
	 */
	async refreshIfWithinWindow(nowInS) {
		if (this.deadlineInS !== null && nowInS >= this.deadlineInS) {
			return;
		}
		if (nowInS < this.expiresAtInS - keycloakTiming.expiryLeewayInS) {
			return;
		}
		if (nowInS < this.nextRefreshAttemptAtInS) {
			if (nowInS < this.expiresAtInS) {
				return;
			}
			throw new KeycloakAuthenticationError(
				'The Keycloak access token has expired and the refresh is backing off after ' +
					`${this.consecutiveRefreshFailures} consecutive failure(s); the next attempt is due in ` +
					`${(this.nextRefreshAttemptAtInS - nowInS).toFixed(1)}s`
			);
		}
		try {
			await this.exchangeRefreshToken();
		} catch (error) {
			this.recordRefreshFailure(error);
			// Re-read the clock: the failed attempt may itself have taken up to the HTTP timeout.
			if (this.nowInS() < this.expiresAtInS) {
				return;
			}
			if (error instanceof KeycloakAuthenticationError) {
				throw error;
			}
			throw new KeycloakAuthenticationError(`Keycloak token refresh failed (${describeError(error)})`, {
				cause: error
			});
		}
		this.recordRefreshSuccess();
	}

	/**
	 * Send one refresh grant with the current offline token and store the response.
	 *
	 * @returns {Promise<void>}
	 *   Resolves once the new tokens are stored.
	 * @throws {KeycloakAuthenticationError}
	 *   When the exchange fails or the response is unusable (no state is changed then).
	 */
	async exchangeRefreshToken() {
		/** @type {Record<string, unknown>} */
		const payload = await postTokenRequest(
			this.tokenEndpoint,
			{
				grant_type: 'refresh_token',
				client_id: this.clientId,
				refresh_token: this.refreshToken === null ? '' : this.refreshToken
			},
			this.fetchImpl,
			this.verifySsl,
			'refresh'
		);
		this.storeTokens(parseTokenPayload(payload));
	}

	/**
	 * Assign a validated token response: the access token, the rotated refresh token (the previous one is
	 * kept when none came back) and the expiry, read from the clock NOW.
	 *
	 * @param {ParsedTokens} tokens
	 *   The validated response.
	 * @returns {void}
	 */
	storeTokens(tokens) {
		this.accessToken = tokens.accessToken;
		if (tokens.refreshToken !== null) {
			this.refreshToken = tokens.refreshToken;
		}
		this.expiresAtInS = this.nowInS() + Math.max(tokens.expiresInS, 0);
	}

	/**
	 * Count a failed refresh, schedule the next attempt with jittered backoff and warn exactly once.
	 * Deliberately NOT a fallback to a password grant: a silent re-login would reintroduce, at the least
	 * predictable moment (a realm restart invalidates every offline session at once), the login burst the
	 * offline token exists to avoid. The backoff is measured from NOW, when the failure is recorded, not
	 * from when the attempt started.
	 *
	 * @param {unknown} error
	 *   What the attempt raised; only its type and message are logged.
	 * @returns {void}
	 */
	recordRefreshFailure(error) {
		/** @type {number} */
		const nowInS = this.nowInS();
		this.consecutiveRefreshFailures += 1;
		/** @type {number} */
		const delayInS = backoffDelayInS(this.consecutiveRefreshFailures, this.randomFraction);
		this.nextRefreshAttemptAtInS = nowInS + delayInS;
		/** @type {number} */
		const remainingInS = this.expiresAtInS - nowInS;
		/** @type {string} */
		const validity =
			remainingInS > 0
				? `the current access token stays valid for ${remainingInS.toFixed(1)}s`
				: 'the current access token has expired';
		this.logger.warn(
			`Keycloak token refresh failed (attempt ${this.consecutiveRefreshFailures}); retrying in ` +
				`${delayInS.toFixed(1)}s, ${validity} (${describeError(error)})`
		);
		if (this.onRefreshErrorHandler !== null) {
			try {
				this.onRefreshErrorHandler(error);
			} catch {
				// A diagnostics handler that throws is the caller's bug; it must not break the refresh.
			}
		}
	}

	/**
	 * Reset the failure backoff after a successful refresh and log the recovery, if there was a failure.
	 *
	 * @returns {void}
	 */
	recordRefreshSuccess() {
		if (this.consecutiveRefreshFailures > 0) {
			this.logger.info(`Keycloak token refresh recovered after ${this.consecutiveRefreshFailures} failed attempt(s)`);
		}
		this.consecutiveRefreshFailures = 0;
		this.nextRefreshAttemptAtInS = 0;
	}

	/**
	 * Force one refresh grant now (outside the schedule). Returns early, without a request, when the
	 * provider is stopped or the bounded deadline has elapsed.
	 *
	 * @returns {Promise<void>}
	 *   Resolves once the access token has been refreshed (or nothing was due).
	 * @throws {KeycloakAuthenticationError}
	 *   When the refresh fails (it is counted in the shared backoff too).
	 */
	refresh() {
		return this.withLock(async () => {
			if (this.stopped || (this.deadlineInS !== null && this.nowInS() >= this.deadlineInS)) {
				return;
			}
			try {
				await this.exchangeRefreshToken();
			} catch (error) {
				this.recordRefreshFailure(error);
				throw error;
			}
			this.recordRefreshSuccess();
		});
	}

	/**
	 * Register a callback invoked with the error of every failed refresh, background or lazy (optional
	 * diagnostics; it already got its WARNING line). A throwing handler is ignored.
	 *
	 * @param {(error: unknown) => void} handler
	 *   The callback receiving the refresh error (a {@link KeycloakAuthenticationError}).
	 * @returns {void}
	 */
	onRefreshError(handler) {
		this.onRefreshErrorHandler = handler;
	}

	/**
	 * The current access token, or `null` before {@link OfflineTokenProvider#bootstrap} has completed. No
	 * refresh is attempted; prefer {@link OfflineTokenProvider#getAuthorizationMetadata}.
	 *
	 * @returns {string | null}
	 *   The current access token, or `null` when login has not completed.
	 */
	getAccessToken() {
		return this.accessToken;
	}

	/**
	 * The value for an `Authorization` header, `Bearer <access_token>`, WITHOUT a refresh check (it is
	 * synchronous). Kept for existing callers; prefer {@link OfflineTokenProvider#getAuthorizationMetadata},
	 * which refreshes a token inside the leeway and refuses an expired one.
	 *
	 * @returns {string}
	 *   The `Bearer <access_token>` header value.
	 * @throws {TokenError}
	 *   When no access token is available because login has not completed.
	 */
	getAuthorizationHeader() {
		if (this.accessToken === null) {
			throw new TokenError('No access token available; login() has not completed or has lapsed');
		}
		return `Bearer ${this.accessToken}`;
	}

	/**
	 * The gRPC metadata carrying the bearer token, `{ authorization: 'Bearer <access_token>' }`, refreshing
	 * first when the token is within the leeway of its expiry. Concurrent callers are single-flight: during
	 * an outage N callers cause ONE token request, and none fails while the token is still valid.
	 *
	 * @returns {Promise<{ authorization: string }>}
	 *   The metadata to merge into every gRPC-web call.
	 * @throws {TokenError}
	 *   When login has not completed.
	 * @throws {KeycloakAuthenticationError}
	 *   When the access token has expired and could not be refreshed.
	 */
	async getAuthorizationMetadata() {
		if (this.accessToken === null) {
			throw new TokenError('No access token available; login() has not completed or has lapsed');
		}
		await this.withLock(() => this.refreshIfWithinWindow(this.nowInS()));
		return { authorization: `Bearer ${this.accessToken}` };
	}

	/**
	 * A logging-safe view of this provider: the access and refresh tokens render as `***REDACTED***`
	 * (`null` or empty stays as is). `JSON.stringify(provider)` uses it, and so do Node's
	 * `console.log(provider)` / `util.inspect(provider)` through the hook below. The password is never
	 * stored on the provider at all.
	 *
	 * @returns {{ tokenEndpoint: string, clientId: string, accessToken: string | null, refreshToken: string | null, stopped: boolean }}
	 *   The endpoint, client id and stop flag, with both tokens redacted.
	 */
	toJSON() {
		return {
			tokenEndpoint: this.tokenEndpoint,
			clientId: this.clientId,
			accessToken: this.accessToken === null || this.accessToken === '' ? this.accessToken : REDACTED,
			refreshToken: this.refreshToken === null || this.refreshToken === '' ? this.refreshToken : REDACTED,
			stopped: this.stopped
		};
	}

	/**
	 * Node's `util.inspect` hook (used by `console.log`): renders {@link OfflineTokenProvider#toJSON}.
	 * Looked up via `Symbol.for`, so no `util` import is needed and the module stays browser-safe.
	 *
	 * @returns {ReturnType<OfflineTokenProvider['toJSON']>}
	 *   The redacted view.
	 */
	[Symbol.for('nodejs.util.inspect.custom')]() {
		return this.toJSON();
	}

	/**
	 * Stop the background loop, interrupting a pending (backoff) wait, so no further request is sent.
	 * Idempotent; safe from any state, without a loop, and from within a refresh-error handler. The lazy
	 * path keeps working on demand afterwards.
	 *
	 * @returns {void}
	 */
	stop() {
		this.stopped = true;
		this.stopSignal.fire();
	}

	/**
	 * {@link OfflineTokenProvider#stop}, then wait for the background loop to exit -- at most
	 * `keycloakTiming.closeTimeoutInS`, so a refresh stuck in its HTTP call cannot block teardown. Never
	 * rejects.
	 *
	 * @returns {Promise<void>}
	 *   Resolves once the loop exited or the wait timed out.
	 */
	async close() {
		this.stop();
		if (this.loopPromise === null) {
			return;
		}
		/** @type {ReturnType<typeof setTimeout> | undefined} */
		let timer;
		/** @type {Promise<void>} */
		const timeout = new Promise((resolve) => {
			// NOT unref-ed: the caller awaits this, and an unref-ed timer would let an otherwise idle
			// process drop the pending close() instead of resolving it. It is bounded and cleared below.
			timer = setTimeout(resolve, keycloakTiming.closeTimeoutInS * 1000);
		});
		await Promise.race([this.loopPromise, timeout]);
		clearTimeout(timer);
	}
}

/**
 * The option names whose value, when present, must be a string.
 *
 * @type {(keyof LoginOptions)[]}
 */
const STRING_OPTION_KEYS = ['keycloakUrl', 'realm', 'clientId', 'username', 'password', 'refreshToken'];

/**
 * Validate the options before any network I/O.
 *
 * @param {LoginOptions | null | undefined} options
 *   The options to validate.
 * @param {string} caller
 *   The public function name for the messages (`login()`).
 * @param {boolean} requireKeycloak
 *   `true` for {@link login}, which can only authenticate; `false` for {@link getKeycloakTokenProvider},
 *   where no Keycloak triple at all means "no auth" rather than an error.
 * @returns {boolean}
 *   Whether Keycloak is configured (the triple is complete); `false` only when none of it is set.
 * @throws {TokenError}
 *   On a missing options object, a non-string option, a partial triple, an empty username, or neither a
 *   password nor a refresh token.
 */
function validateLoginOptions(options, caller, requireKeycloak) {
	if (options === undefined || options === null) {
		throw new TokenError(`${caller} requires an options object`);
	}
	for (const key of STRING_OPTION_KEYS) {
		/** @type {unknown} */
		const value = options[key];
		if (value !== undefined && value !== null && typeof value !== 'string') {
			throw new TokenError(`${caller} option "${key}" must be a string`);
		}
	}
	/** @type {number} */
	const tripleCount = [options.keycloakUrl, options.realm, options.clientId].filter(
		(value) => typeof value === 'string' && value.length > 0
	).length;
	if (tripleCount === 0 && !requireKeycloak) {
		return false;
	}
	if (tripleCount !== 3) {
		throw new TokenError(
			`${caller}: the Keycloak options \`keycloakUrl\`, \`realm\`, and \`clientId\` must be provided together`
		);
	}
	if (typeof options.username !== 'string' || options.username.length === 0) {
		throw new TokenError(`${caller} option "username" is required and must be a non-empty string`);
	}
	if (!options.password && !options.refreshToken) {
		throw new TokenError(
			`${caller}: either the option \`password\` or the option \`refreshToken\` (a Keycloak offline ` +
				'refresh_token) is mandatory'
		);
	}
	return true;
}

/**
 * Authenticate against the PUBLIC SDK client and return a live, unshared token provider whose access
 * token is auto-refreshed until `tokenExpirationInS` elapses. With `refreshToken` set, start-up is one
 * refresh grant with that handed-off offline token (the password is optional and never sent); otherwise
 * a one-time ROPC + offline_access login. Prefer {@link getKeycloakTokenProvider} to share one provider
 * (one login) between all clients of the same credentials.
 *
 * @param {LoginOptions} options
 *   The connection, credential, and (optional) injectable-dependency options.
 * @returns {Promise<OfflineTokenProvider>}
 *   A live provider with a valid access token and a running background refresh.
 * @throws {TokenError}
 *   When the options are unusable (see {@link validateLoginOptions}).
 * @throws {KeycloakAuthenticationError}
 *   When the initial token request fails or returns an unusable body.
 */
async function login(options) {
	validateLoginOptions(options, 'login()', true);
	/** @type {OfflineTokenProvider} */
	const provider = new OfflineTokenProvider(options);
	await provider.bootstrap(options.username, options.password);
	return provider;
}

/**
 * One registry slot: the in-flight creation, or a weak reference to the created provider.
 *
 * @typedef {object} RegistrySlot
 * @property {Promise<OfflineTokenProvider> | null} pending
 *   The creation in flight, or `null` once it settled.
 * @property {{ deref: () => (OfflineTokenProvider | undefined) } | null} ref
 *   The created provider, held weakly; `null` while pending.
 */

/**
 * One provider per credential set, held WEAKLY: a provider nobody references any more is collected and
 * its background loop exits. Keyed by a SHA-256 of the credentials, never by object identity.
 *
 * @type {Map<string, RegistrySlot>}
 */
const providerRegistry = new Map();

/**
 * Drop the registry slot of a provider that was garbage-collected (the FinalizationRegistry callback).
 *
 * @param {string} key
 *   The registry key of the collected provider.
 * @returns {void}
 */
function forgetCollectedProvider(key) {
	/** @type {RegistrySlot | undefined} */
	const slot = providerRegistry.get(key);
	if (slot !== undefined && slot.ref !== null && slot.ref.deref() === undefined) {
		providerRegistry.delete(key);
	}
}

/** @type {FinalizationRegistry<string>} */
const providerFinalizer = new FinalizationRegistry(forgetCollectedProvider);

/**
 * Derive the registry key of a credential set: the SHA-256 hex of every field the provider is built from,
 * joined with `\0`. Hashed so the registry holds no secret; `refreshToken` takes part because two
 * token-only configs carry the same EMPTY password and would otherwise share one tenant's provider.
 *
 * @param {LoginOptions} options
 *   Validated options.
 * @returns {Promise<string>}
 *   64 lowercase hex characters.
 */
async function providerRegistryKey(options) {
	/** @type {string[]} */
	const fields = [
		options.keycloakUrl,
		options.realm,
		options.clientId,
		options.username,
		options.password === undefined || options.password === null ? '' : options.password,
		options.tokenExpirationInS === undefined || options.tokenExpirationInS === null
			? ''
			: String(options.tokenExpirationInS),
		String(options.keycloakVerifySsl !== false),
		options.refreshToken === undefined || options.refreshToken === null ? '' : options.refreshToken
	];
	/** @type {ArrayBuffer} */
	const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(fields.join('\0')));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Return the SHARED provider for a credential set, creating it (one login) on first use. Concurrent first
 * calls share one creation; a stopped or collected provider is never handed out (a new one is created).
 * Returns `null` when none of `keycloakUrl`, `realm`, `clientId` is set: no Keycloak, no auth metadata.
 *
 * @param {LoginOptions} options
 *   The same options as {@link login}.
 * @returns {Promise<OfflineTokenProvider | null>}
 *   The shared provider, or `null` when Keycloak is not configured.
 * @throws {TokenError}
 *   When the options are unusable (a partial triple included).
 * @throws {KeycloakAuthenticationError}
 *   When the initial token request fails (nothing is cached then).
 */
async function getKeycloakTokenProvider(options) {
	if (!validateLoginOptions(options, 'getKeycloakTokenProvider()', false)) {
		return null;
	}
	/** @type {string} */
	const key = await providerRegistryKey(options);
	/** @type {RegistrySlot | undefined} */
	const existing = providerRegistry.get(key);
	if (existing !== undefined) {
		if (existing.pending !== null) {
			return existing.pending;
		}
		/** @type {OfflineTokenProvider | undefined} */
		const provider = /** @type {NonNullable<RegistrySlot['ref']>} */ (existing.ref).deref();
		if (provider !== undefined && !provider.stopped) {
			return provider;
		}
	}
	/** @type {RegistrySlot} */
	const slot = { pending: login(options), ref: null };
	providerRegistry.set(key, slot);
	try {
		/** @type {OfflineTokenProvider} */
		const provider = await /** @type {Promise<OfflineTokenProvider>} */ (slot.pending);
		slot.ref = new WeakRef(provider);
		slot.pending = null;
		providerFinalizer.register(provider, key);
		return provider;
	} catch (error) {
		if (providerRegistry.get(key) === slot) {
			providerRegistry.delete(key);
		}
		throw error;
	}
}

/**
 * Stop every provider in the shared registry and forget them all (application shutdown, tests).
 *
 * @returns {void}
 */
function clearKeycloakTokenProviders() {
	for (const slot of providerRegistry.values()) {
		/** @type {OfflineTokenProvider | undefined} */
		const provider = slot.ref === null ? undefined : slot.ref.deref();
		if (provider !== undefined) {
			provider.stop();
		}
	}
	providerRegistry.clear();
}

/**
 * A logging-safe copy of login options: a non-empty `password` or `refreshToken` renders as
 * `***REDACTED***`, an empty one stays empty ("nobody set it" is usually what is being debugged).
 *
 * @param {LoginOptions} options
 *   The options to render.
 * @returns {Record<string, unknown>}
 *   A shallow copy with both secrets redacted.
 */
function redactLoginOptions(options) {
	/** @type {Record<string, unknown>} */
	const copy = { ...options };
	for (const key of ['password', 'refreshToken']) {
		if (typeof copy[key] === 'string' && copy[key] !== '') {
			copy[key] = REDACTED;
		}
	}
	return copy;
}

/**
 * The subset of a grpc-web unary request an interceptor touches.
 *
 * @typedef {object} GrpcWebRequestLike
 * @property {() => Record<string, string>} getMetadata
 *   The request's mutable metadata object.
 */

/**
 * A grpc-web unary interceptor that awaits the provider's metadata and merges `authorization: Bearer ...`
 * into every unary call. Pass it to a generated `*PromiseClient` as
 * `new AgentsPromiseClient(host, null, { unaryInterceptors: [createAuthUnaryInterceptor(provider)] })`.
 * grpc-web stream interceptors are synchronous, so for a server-streaming call pass
 * `await provider.getAuthorizationMetadata()` as its metadata instead. A refresh failure on an expired
 * token rejects the call with the {@link KeycloakAuthenticationError} and nothing is sent.
 *
 * @param {{ getAuthorizationMetadata: () => Promise<{ authorization: string }> }} provider
 *   The token provider.
 * @returns {{ intercept: (request: GrpcWebRequestLike, invoker: (request: GrpcWebRequestLike) => Promise<unknown>) => Promise<unknown> }}
 *   The interceptor.
 */
function createAuthUnaryInterceptor(provider) {
	return {
		intercept(request, invoker) {
			return provider.getAuthorizationMetadata().then((metadata) => {
				Object.assign(request.getMetadata(), metadata);
				return invoker(request);
			});
		}
	};
}

module.exports = {
	TokenError,
	KeycloakAuthenticationError,
	OfflineTokenProvider,
	login,
	getKeycloakTokenProvider,
	clearKeycloakTokenProviders,
	providerRegistryKey,
	redactLoginOptions,
	createAuthUnaryInterceptor,
	backoffDelayInS,
	keycloakTiming,
	KEYCLOAK_TIMING_DEFAULTS,
	INSECURE_AGENT_OPTIONS,
	/** Internals exposed for the unit tests only; not part of the public API. */
	_internal: { runRefreshLoop, providerRegistry, forgetCollectedProvider, StopSignal }
};
