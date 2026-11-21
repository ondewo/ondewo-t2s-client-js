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

// Unit tests for the Keycloak token provider, implementing the TEST CATALOGUE (T01..T62) of the
// cross-language "ONDEWO client SDK Keycloak token handling" specification, plus this SDK's own edge
// cases. The token endpoint is a scripted fake `fetchImpl`, the clock a fake monotonic clock, the jitter a
// fixed fraction and the background loop's wait a scripted scheduler -- there is NO network access and no
// real sleep, except in T26 (50 ms) and T41 (the real timer end to end, with shrunk constants).
//   node --test auth/offlineTokenProvider.spec.js
//
// Default script (spec §3): clock 1000 s, first token `acc-1` with `expires_in` 300 and refresh token
// `off-1`; `refused` is HTTP 400 {"error":"invalid_grant","error_description":"Offline user session not found"}.
//
// T55 (`refresh_token` appended LAST on every positional surface): this SDK takes an options OBJECT
// everywhere, so the only positional surfaces are `new OfflineTokenProvider(options)` and
// `bootstrap(username, password)`, neither of which gained a parameter; the T55 case pins exactly that.

'use strict';

/* global require, process, URLSearchParams, setTimeout, performance, DOMException, AbortSignal */

const { test: runTestCase, mock } = require('node:test');
const assert = require('node:assert/strict');
const { inspect } = require('node:util');

const { Agent } = require('undici');

const {
	login,
	getKeycloakTokenProvider,
	clearKeycloakTokenProviders,
	providerRegistryKey,
	redactLoginOptions,
	createAuthUnaryInterceptor,
	backoffDelayInS,
	keycloakTiming,
	KEYCLOAK_TIMING_DEFAULTS,
	OfflineTokenProvider,
	TokenError,
	KeycloakAuthenticationError,
	INSECURE_AGENT_OPTIONS,
	_internal
} = require('./offlineTokenProvider');

// region fixtures

/**
 * A provider instance (a class name in a JSDoc type of a CommonJS file names the constructor).
 *
 * @typedef {InstanceType<typeof OfflineTokenProvider>} ProviderInstance
 */

/**
 * An authentication error instance.
 *
 * @typedef {InstanceType<typeof KeycloakAuthenticationError>} AuthError
 */

/**
 * The shared, valid {@link login} options. Tests spread this and override the fields under test.
 *
 * @type {{ keycloakUrl: string, realm: string, clientId: string, username: string, password: string }}
 */
const BASE_OPTIONS = {
	keycloakUrl: 'https://auth.example.com/auth',
	realm: 'ondewo-ccai-platform',
	clientId: 'ondewo-nlu-cai-sdk-public',
	username: 'tech-user@example.com',
	password: 'super-secret'
};

/**
 * The token endpoint derived from {@link BASE_OPTIONS}.
 *
 * @type {string}
 */
const EXPECTED_TOKEN_ENDPOINT =
	'https://auth.example.com/auth/realms/ondewo-ccai-platform/protocol/openid-connect/token';

/**
 * One scripted answer of the fake token endpoint. Exactly one of `body`, `error` or `response` is used:
 * `body` (an object is JSON-encoded, a string is sent verbatim) with an optional `status` (default 200);
 * `error` is thrown by the transport; `response` is resolved as is (to model a broken transport). `advanceS`
 * moves the fake clock while the request is in flight, `delayMs` delays the answer on a real timer.
 *
 * @typedef {object} ScriptEntry
 * @property {object | string} [body]
 *   The response body.
 * @property {number} [status]
 *   The HTTP status, default 200.
 * @property {unknown} [error]
 *   A value the transport throws instead of answering.
 * @property {object} [response]
 *   A raw response object resolved instead of a well-formed one.
 * @property {number} [advanceS]
 *   Seconds the fake clock advances during the request.
 * @property {number} [delayMs]
 *   Real milliseconds before the answer (or the error) is delivered.
 */

/**
 * The fake monotonic clock: seconds, starting at 1000.
 *
 * @typedef {object} FakeClock
 * @property {() => number} nowInMs
 *   The clock as the provider reads it, in milliseconds.
 * @property {(seconds: number) => void} advance
 *   Moves the clock forward.
 * @property {() => number} nowInS
 *   The clock in seconds.
 */

/**
 * Build a fake monotonic clock.
 *
 * @param {number} [startInS]
 *   The start time in seconds; default 1000.
 * @returns {FakeClock}
 *   The clock.
 */
function makeClock(startInS = 1000) {
	/** @type {number} */
	let nowInS = startInS;
	return {
		nowInMs: () => nowInS * 1000,
		advance: (seconds) => {
			nowInS += seconds;
		},
		nowInS: () => nowInS
	};
}

/**
 * One request the fake endpoint received.
 *
 * @typedef {object} RecordedRequest
 * @property {string} url
 *   The request URL.
 * @property {any} init
 *   The raw `fetch` init (method, headers, body, signal, dispatcher).
 * @property {Record<string, string>} form
 *   The decoded form fields.
 */

/**
 * The fake token endpoint: a `fetchImpl` and everything it received.
 *
 * @typedef {object} FakeEndpoint
 * @property {(url: string, init: object) => Promise<any>} fetchImpl
 *   The injectable `fetch` replacement.
 * @property {RecordedRequest[]} requests
 *   Every request, in order.
 * @property {() => string[]} grants
 *   The `grant_type` of every request, in order.
 */

/**
 * Build a fake token endpoint answering `script` one entry per request; it fails the test loudly when
 * called more often than scripted. `fallback`, when given, answers every request past the script.
 *
 * @param {ScriptEntry[]} script
 *   The scripted answers.
 * @param {{ clock?: FakeClock, fallback?: ScriptEntry }} [settings]
 *   The clock to advance and an answer for every request past the script.
 * @returns {FakeEndpoint}
 *   The endpoint.
 */
function makeEndpoint(script, settings = {}) {
	/** @type {RecordedRequest[]} */
	const requests = [];
	/** @type {ScriptEntry[]} */
	const remaining = [...script];
	return {
		requests,
		grants: () => requests.map((request) => request.form.grant_type),
		fetchImpl: (url, init) => {
			/** @type {any} */
			const requestInit = init;
			requests.push({ url, init: requestInit, form: Object.fromEntries(new URLSearchParams(requestInit.body)) });
			/** @type {ScriptEntry | undefined} */
			const entry = remaining.length > 0 ? remaining.shift() : settings.fallback;
			if (entry === undefined) {
				return Promise.reject(new Error('fake token endpoint called more often than scripted'));
			}
			if (entry.advanceS !== undefined && settings.clock !== undefined) {
				settings.clock.advance(entry.advanceS);
			}
			/** @type {() => Promise<any>} */
			const answer = () => {
				if (entry.error !== undefined) {
					return Promise.reject(entry.error);
				}
				if (entry.response !== undefined) {
					return Promise.resolve(entry.response);
				}
				/** @type {number} */
				const status = entry.status !== undefined ? entry.status : 200;
				/** @type {string} */
				const text = typeof entry.body === 'string' ? entry.body : JSON.stringify(entry.body);
				return Promise.resolve({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(text) });
			};
			if (entry.delayMs !== undefined) {
				return new Promise((resolve) => setTimeout(resolve, entry.delayMs)).then(answer);
			}
			return answer();
		}
	};
}

/**
 * A successful token answer.
 *
 * @param {string} accessToken
 *   The access token.
 * @param {{ expiresIn?: unknown, refreshToken?: string | null }} [fields]
 *   `expires_in` (default 300) and the refresh token (default `off-1`; `null` omits it).
 * @returns {ScriptEntry}
 *   The script entry.
 */
function token(accessToken, fields = {}) {
	/** @type {Record<string, unknown>} */
	const body = { access_token: accessToken, expires_in: 'expiresIn' in fields ? fields.expiresIn : 300 };
	/** @type {string | null} */
	const refreshToken = fields.refreshToken === undefined ? 'off-1' : fields.refreshToken;
	if (refreshToken !== null) {
		body.refresh_token = refreshToken;
	}
	return { body };
}

/**
 * The spec's `refused` answer: HTTP 400 invalid_grant.
 *
 * @type {ScriptEntry}
 */
const REFUSED = {
	status: 400,
	body: { error: 'invalid_grant', error_description: 'Offline user session not found' }
};

/**
 * An HTTP 503 answer.
 *
 * @type {ScriptEntry}
 */
const UNAVAILABLE = { status: 503, body: { error: 'temporarily_unavailable' } };

/**
 * A logger capturing every line per level.
 *
 * @typedef {{ warn: string[], info: string[], debug: string[], logger: { warn: (m: string) => void, info: (m: string) => void, debug: (m: string) => void } }} CapturingLogger
 */

/**
 * Build a logger that records every line.
 *
 * @returns {CapturingLogger}
 *   The lines and the logger.
 */
function makeLogger() {
	/** @type {string[]} */
	const warn = [];
	/** @type {string[]} */
	const info = [];
	/** @type {string[]} */
	const debug = [];
	return {
		warn,
		info,
		debug,
		logger: {
			warn: (message) => warn.push(message),
			info: (message) => info.push(message),
			debug: (message) => debug.push(message)
		}
	};
}

/**
 * A scripted scheduler for the background loop: every wait records its delay, advances the fake clock by
 * it and times out, until `timedOutWaits` waits have elapsed; the next one reports "stopped".
 *
 * @param {FakeClock} clock
 *   The clock to advance.
 * @param {number} timedOutWaits
 *   How many waits time out before one reports "stopped".
 * @returns {{ waits: number[], waitImpl: (delayInS: number) => Promise<boolean> }}
 *   The recorded delays and the wait.
 */
function makeScheduler(clock, timedOutWaits) {
	/** @type {number[]} */
	const waits = [];
	return {
		waits,
		waitImpl: (delayInS) => {
			waits.push(delayInS);
			if (waits.length > timedOutWaits) {
				return Promise.resolve(true);
			}
			clock.advance(delayInS);
			return Promise.resolve(false);
		}
	};
}

/**
 * Everything a test needs around one provider.
 *
 * @typedef {object} Harness
 * @property {ProviderInstance} provider
 *   The provider (bootstrapped).
 * @property {FakeClock} clock
 *   Its clock.
 * @property {FakeEndpoint} endpoint
 *   Its token endpoint.
 * @property {CapturingLogger} log
 *   Its logger.
 * @property {number[]} waits
 *   The delays the loop waited (when a scheduler was used).
 */

/**
 * Log in through the fake endpoint with a fake clock, a fixed jitter of 1.0 and NO background loop
 * (start it with {@link runLoop}).
 *
 * @param {ScriptEntry[]} script
 *   The endpoint script, the initial acquisition first.
 * @param {Record<string, unknown>} [overrides]
 *   Extra login options.
 * @param {{ fallback?: ScriptEntry }} [endpointSettings]
 *   An answer for every request past the script.
 * @returns {Promise<Harness>}
 *   The harness.
 */
async function makeHarness(script, overrides = {}, endpointSettings = {}) {
	/** @type {FakeClock} */
	const clock = makeClock();
	/** @type {FakeEndpoint} */
	const endpoint = makeEndpoint(script, { clock, ...endpointSettings });
	/** @type {CapturingLogger} */
	const log = makeLogger();
	/** @type {ProviderInstance} */
	const provider = await login(
		/** @type {any} */ ({
			...BASE_OPTIONS,
			fetchImpl: endpoint.fetchImpl,
			nowInMs: clock.nowInMs,
			randomFraction: () => 1.0,
			logger: log.logger,
			startBackgroundRefresh: false,
			...overrides
		})
	);
	return { provider, clock, endpoint, log, waits: [] };
}

/**
 * Run the background loop of a harness's provider on a scripted scheduler until it exits.
 *
 * @param {Harness} harness
 *   The harness.
 * @param {number} timedOutWaits
 *   How many waits time out before the scheduler reports "stopped".
 * @returns {Promise<number[]>}
 *   The delays the loop waited.
 */
async function runLoop(harness, timedOutWaits) {
	const scheduler = makeScheduler(harness.clock, timedOutWaits);
	harness.provider.waitImpl = scheduler.waitImpl;
	harness.provider.startRefreshLoop();
	await harness.provider.loopPromise;
	harness.waits.push(...scheduler.waits);
	return scheduler.waits;
}

/**
 * Await a promise expected to reject with a {@link KeycloakAuthenticationError} and return it.
 *
 * @param {Promise<unknown>} promise
 *   The promise.
 * @returns {Promise<AuthError>}
 *   The error.
 */
async function rejection(promise) {
	try {
		await promise;
	} catch (error) {
		assert.ok(error instanceof KeycloakAuthenticationError, String(error));
		assert.ok(error instanceof TokenError);
		return error;
	}
	throw new assert.AssertionError({ message: 'expected a KeycloakAuthenticationError' });
}

/**
 * Restore every timing constant to its production value (after a test shrank them).
 *
 * @returns {void}
 */
function restoreTiming() {
	Object.assign(keycloakTiming, KEYCLOAK_TIMING_DEFAULTS);
}

// endregion

// region A. backoff ladder

runTestCase('T01 the backoff ceiling doubles up to the 300 s cap', () => {
	assert.deepEqual(
		[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((failures) => backoffDelayInS(failures, () => 1.0)),
		[5, 10, 20, 40, 80, 160, 300, 300, 300, 300]
	);
});

runTestCase('T02 a jitter of 0.0 always waits the 5 s base', () => {
	for (let failures = 1; failures <= 19; failures += 1) {
		assert.equal(
			backoffDelayInS(failures, () => 0.0),
			5
		);
	}
});

runTestCase('T03 the delay is drawn inside the jitter window', () => {
	assert.equal(
		backoffDelayInS(2, () => 0.5),
		7.5
	);
	assert.equal(
		backoffDelayInS(3, () => 0.25),
		8.75
	);
});

runTestCase('T04 a faulty jitter source is clamped into the window (NaN included)', () => {
	for (const fraction of [-1, -0.001, 1.5, 1e9, Number.NaN]) {
		/** @type {number} */
		const delay = backoffDelayInS(4, () => fraction);
		assert.ok(delay >= 5 && delay <= 40, `${fraction} -> ${delay}`);
	}
});

runTestCase('T05 zero, negative and NaN failure counts behave as one failure', () => {
	for (const failures of [0, -3, Number.NaN]) {
		assert.equal(
			backoffDelayInS(failures, () => 1.0),
			5
		);
	}
});

runTestCase('T06 a huge failure count never overflows', () => {
	assert.equal(
		backoffDelayInS(1e9, () => 1.0),
		300
	);
	assert.equal(
		backoffDelayInS(Number.MAX_SAFE_INTEGER, () => 1.0),
		300
	);
	assert.equal(
		backoffDelayInS(Infinity, () => 1.0),
		300
	);
});

runTestCase('T07 the timing constants keep their relations and equal the specification', () => {
	assert.deepEqual(KEYCLOAK_TIMING_DEFAULTS, {
		expiryLeewayInS: 30,
		minRefreshDelayInS: 1,
		retryBaseDelayInS: 5,
		retryMaxDelayInS: 300,
		maxRetryExponent: 6,
		httpTimeoutInS: 10,
		maxErrorBodyChars: 500,
		closeTimeoutInS: 5
	});
	assert.deepEqual(keycloakTiming, KEYCLOAK_TIMING_DEFAULTS);
	assert.ok(Object.isFrozen(KEYCLOAK_TIMING_DEFAULTS));
	const timing = KEYCLOAK_TIMING_DEFAULTS;
	assert.ok(timing.retryBaseDelayInS > timing.minRefreshDelayInS);
	assert.ok(timing.retryBaseDelayInS * 2 ** timing.maxRetryExponent >= timing.retryMaxDelayInS);
	assert.ok(timing.httpTimeoutInS < timing.expiryLeewayInS);
});

// endregion

// region B. the background loop survives every failure

runTestCase('T08 a refused refresh followed by a success keeps the loop alive', async () => {
	const harness = await makeHarness([token('acc-1'), REFUSED, token('acc-3')]);
	await runLoop(harness, 2);
	assert.deepEqual(harness.endpoint.grants(), ['password', 'refresh_token', 'refresh_token']);
	assert.equal(harness.provider.getAccessToken(), 'acc-3');
	assert.equal(harness.provider.consecutiveRefreshFailures, 0);
});

/**
 * Every failure kind T09 must survive, by name.
 *
 * @type {[string, ScriptEntry][]}
 */
const FAILURE_KINDS = [
	['network error', { error: new TypeError('fetch failed') }],
	[
		'connection refused',
		{
			error: new TypeError('fetch failed', {
				cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
			})
		}
	],
	['timeout', { error: new DOMException('The operation was aborted due to timeout', 'TimeoutError') }],
	['a non-auth error thrown by the transport (bug)', { error: new RangeError('transport bug') }],
	[
		'a broken transport answer (bug)',
		{
			response: {
				get status() {
					throw new RangeError('broken status');
				},
				text: () => Promise.resolve('')
			}
		}
	],
	['HTTP 503 with a JSON body', UNAVAILABLE],
	['HTTP 502 with an empty body', { status: 502, body: '' }],
	['200 with a non-JSON body', { body: '<html>bad gateway</html>' }],
	['200 with a JSON array', { body: '[1, 2]' }],
	['200 without an access_token', { body: { refresh_token: 'off-9', expires_in: 300 } }],
	['200 with expires_in "soon"', { body: { access_token: 'acc-x', expires_in: 'soon' } }]
];

for (const [kind, failure] of FAILURE_KINDS) {
	runTestCase(`T09 no failure kind ends the loop: ${kind}`, async () => {
		const harness = await makeHarness([token('acc-1'), failure, token('acc-ok')]);
		await runLoop(harness, 2);
		assert.equal(harness.endpoint.requests.length, 3);
		assert.equal(harness.provider.getAccessToken(), 'acc-ok');
		assert.equal(harness.log.warn.length, 1);
	});
}

runTestCase('T10 a persistent failure keeps the old token and keeps counting', async () => {
	const harness = await makeHarness([token('acc-1')], {}, { fallback: UNAVAILABLE });
	await runLoop(harness, 6);
	assert.deepEqual(harness.endpoint.grants(), ['password', ...Array(6).fill('refresh_token')]);
	assert.equal(harness.provider.getAccessToken(), 'acc-1');
	assert.equal(harness.provider.consecutiveRefreshFailures, 6);
	// The token expired during the outage: the loop swallowed the raised error with ONE debug note each.
	assert.ok(harness.log.debug.length >= 1);
	assert.equal(harness.log.warn.length, 6);
});

runTestCase('T11 a refused client is never answered with a password grant', async () => {
	const harness = await makeHarness(
		[token('acc-1')],
		{},
		{ fallback: { status: 401, body: { error: 'invalid_client' } } }
	);
	await runLoop(harness, 10);
	assert.equal(harness.endpoint.grants().filter((grant) => grant === 'password').length, 1);
	assert.equal(harness.endpoint.requests.length, 11);
});

// endregion

// region C. the background loop backs off

runTestCase('T12 the first wait is the leeway before expiry, the next one after a failure the 5 s base', async () => {
	const harness = await makeHarness([token('acc-1'), UNAVAILABLE]);
	const waits = await runLoop(harness, 1);
	assert.deepEqual(waits, [270, 5]);
});

runTestCase('T13 a persistent outage walks the jittered ladder up to the cap', async () => {
	const harness = await makeHarness([token('acc-1')], {}, { fallback: UNAVAILABLE });
	const waits = await runLoop(harness, 9);
	assert.deepEqual(waits.slice(1, 10), [5, 10, 20, 40, 80, 160, 300, 300, 300]);
});

runTestCase('T14 a success resets the ladder and logs one recovery', async () => {
	const harness = await makeHarness([
		token('acc-1'),
		UNAVAILABLE,
		UNAVAILABLE,
		token('acc-4', { expiresIn: 120 }),
		UNAVAILABLE
	]);
	const waits = await runLoop(harness, 4);
	assert.deepEqual(waits, [270, 5, 10, 90, 5]);
	assert.equal(harness.log.info.length, 1);
	assert.ok(harness.log.info[0].includes('recovered after 2 failed attempt(s)'), harness.log.info[0]);
});

runTestCase('T15 the backoff is measured from when the failure is recorded', async () => {
	const harness = await makeHarness([token('acc-1'), { ...UNAVAILABLE, advanceS: 10 }]);
	const waits = await runLoop(harness, 1);
	assert.deepEqual(waits, [270, 5]);
});

runTestCase('T16 the deadline ends the loop during a backoff', async () => {
	const harness = await makeHarness(
		[token('acc-1', { expiresIn: 30 })],
		{ tokenExpirationInS: 100 },
		{ fallback: UNAVAILABLE }
	);
	const waits = await runLoop(harness, 1000);
	assert.ok(harness.clock.nowInS() <= 1000 + 100 + 1, String(harness.clock.nowInS()));
	assert.equal(harness.provider.stopped, true);
	assert.ok(waits.every((delay) => delay <= 100));
	assert.ok(waits.length < 1000);
});

runTestCase('T17 a stop during a backoff wait sends no further request', async () => {
	const harness = await makeHarness([token('acc-1'), UNAVAILABLE]);
	const waits = await runLoop(harness, 1);
	assert.equal(waits.length, 2);
	assert.deepEqual(harness.endpoint.grants(), ['password', 'refresh_token']);
});

runTestCase('T17 stop() interrupts a REAL pending backoff timer', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		const clock = makeClock();
		const endpoint = makeEndpoint([token('acc-1', { expiresIn: 31 }), UNAVAILABLE]);
		const provider = await login({
			...BASE_OPTIONS,
			fetchImpl: endpoint.fetchImpl,
			nowInMs: clock.nowInMs,
			randomFraction: () => 1.0,
			logger: makeLogger().logger
		});
		// expires_in 31 - 30 = 1 s floor: the first real wait.
		clock.advance(1);
		mock.timers.tick(1000);
		for (let turn = 0; turn < 10; turn += 1) {
			await new Promise((resolve) => process.nextTick(resolve));
		}
		assert.deepEqual(endpoint.grants(), ['password', 'refresh_token']);
		// The loop now sleeps the 5 s backoff on a real timer; stop() must end that wait at once.
		provider.stop();
		await provider.loopPromise;
		mock.timers.tick(1_000_000);
		assert.deepEqual(endpoint.grants(), ['password', 'refresh_token']);
	} finally {
		mock.timers.reset();
	}
});

runTestCase('T18 a provider that is gone ends the loop without a request', async () => {
	const signal = new _internal.StopSignal();
	/** @type {number[]} */
	const waits = [];
	// Gone before the first iteration.
	await _internal.runRefreshLoop(
		{ deref: () => undefined },
		signal,
		() => Promise.resolve(false),
		() => 0,
		makeLogger().logger
	);
	// Gone while the loop slept: the second deref answers undefined.
	const harness = await makeHarness([token('acc-1')]);
	/** @type {(ProviderInstance | undefined)[]} */
	const derefs = [harness.provider, undefined];
	await _internal.runRefreshLoop(
		{ deref: () => derefs.shift() },
		signal,
		(delayInS) => {
			waits.push(delayInS);
			return Promise.resolve(false);
		},
		harness.clock.nowInMs,
		harness.log.logger
	);
	assert.deepEqual(waits, [270]);
	assert.equal(harness.endpoint.requests.length, 1);
	// A provider stopped before its loop starts never waits at all.
	harness.provider.stop();
	await runLoop(harness, 5);
	assert.deepEqual(harness.waits, []);
});

// endregion

// region D. the lazy path shares the backoff

runTestCase('T19 a token inside the leeway is served when its refresh fails', async () => {
	const harness = await makeHarness([token('acc-1'), UNAVAILABLE]);
	harness.clock.advance(271);
	assert.deepEqual(await harness.provider.getAuthorizationMetadata(), { authorization: 'Bearer acc-1' });
	assert.equal(harness.log.warn.length, 1);
	assert.ok(harness.log.warn[0].includes('refresh failed (attempt 1)'), harness.log.warn[0]);
	assert.ok(harness.log.warn[0].includes('stays valid for 29.0s'), harness.log.warn[0]);
});

runTestCase('T20 no token request is sent while the backoff runs', async () => {
	const harness = await makeHarness([token('acc-1'), UNAVAILABLE]);
	harness.clock.advance(275);
	for (let call = 0; call < 100; call += 1) {
		assert.deepEqual(await harness.provider.getAuthorizationMetadata(), { authorization: 'Bearer acc-1' });
		harness.clock.advance(0.04);
	}
	assert.deepEqual(harness.endpoint.grants(), ['password', 'refresh_token']);
});

runTestCase('T21 an expired token raises while the refresh backs off', async () => {
	const harness = await makeHarness([token('acc-1'), UNAVAILABLE]);
	harness.clock.advance(299);
	await harness.provider.getAuthorizationMetadata();
	harness.clock.advance(2);
	const error = await rejection(harness.provider.getAuthorizationMetadata());
	assert.ok(error.message.includes('backing off after 1 consecutive failure'), error.message);
	assert.ok(error.message.includes('next attempt is due in 3.0s'), error.message);
	assert.equal(harness.endpoint.requests.length, 2);
});

runTestCase('T22 an expired token whose refresh is refused raises the status', async () => {
	const harness = await makeHarness([token('acc-1'), REFUSED]);
	harness.clock.advance(400);
	const error = await rejection(harness.provider.getAuthorizationMetadata());
	assert.ok(error.message.includes('status 400'), error.message);
	assert.ok(error.message.includes('Offline user session not found'), error.message);
	assert.ok(harness.log.warn[0].includes('the current access token has expired'), harness.log.warn[0]);
});

runTestCase('T23 a transport error on an expired token is raised typed, with its cause', async () => {
	const cause = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
	const harness = await makeHarness([token('acc-1'), { error: cause }]);
	harness.clock.advance(400);
	const error = await rejection(harness.provider.getAuthorizationMetadata());
	assert.equal(error.cause, cause);
	assert.ok(error.message.includes('could not reach the token endpoint (Error: socket hang up)'), error.message);
});

runTestCase(
	'T23 a non-auth error (broken transport answer) on an expired token is wrapped, with its cause',
	async () => {
		const harness = await makeHarness([token('acc-1'), /** @type {ScriptEntry} */ (FAILURE_KINDS[4][1])]);
		harness.clock.advance(400);
		const error = await rejection(harness.provider.getAuthorizationMetadata());
		assert.ok(error.cause instanceof RangeError);
		assert.equal(error.message, 'Keycloak token refresh failed (RangeError: broken status)');
	}
);

runTestCase('T24 the lazy path recovers once the backoff elapsed', async () => {
	const harness = await makeHarness([token('acc-1'), UNAVAILABLE, token('acc-3')]);
	harness.clock.advance(280);
	await harness.provider.getAuthorizationMetadata();
	harness.clock.advance(5);
	assert.deepEqual(await harness.provider.getAuthorizationMetadata(), { authorization: 'Bearer acc-3' });
	assert.equal(harness.provider.consecutiveRefreshFailures, 0);
	assert.equal(harness.provider.nextRefreshAttemptAtInS, 0);
	assert.equal(harness.log.info.length, 1);
	assert.ok(harness.log.info[0].includes('recovered after 1 failed attempt'), harness.log.info[0]);
});

runTestCase('T25 a lazy failure schedules the background loop', async () => {
	const harness = await makeHarness([token('acc-1'), UNAVAILABLE, token('acc-3')]);
	harness.clock.advance(280);
	await harness.provider.getAuthorizationMetadata();
	harness.clock.advance(2);
	const waits = await runLoop(harness, 1);
	assert.ok(Math.abs(waits[0] - 3) < 1e-9, String(waits[0]));
	assert.equal(harness.provider.getAccessToken(), 'acc-3');
});

runTestCase('T26 16 concurrent callers during an outage cause ONE token request and no error', async () => {
	const harness = await makeHarness(
		[token('acc-1', { expiresIn: 20 })],
		{},
		{ fallback: { error: new TypeError('fetch failed'), delayMs: 50 } }
	);
	/**
	 * One caller: 20 sequential reads.
	 * @returns {Promise<string[]>}
	 *   Every authorization value it got.
	 */
	const caller = async () => {
		/** @type {string[]} */
		const values = [];
		for (let call = 0; call < 20; call += 1) {
			values.push((await harness.provider.getAuthorizationMetadata()).authorization);
		}
		return values;
	};
	/** @type {string[][]} */
	const results = await Promise.all(Array.from({ length: 16 }, caller));
	assert.equal(results.flat().length, 320);
	assert.ok(results.flat().every((value) => value === 'Bearer acc-1'));
	assert.deepEqual(harness.endpoint.grants(), ['password', 'refresh_token']);
});

// endregion

// region E. response validation

for (const [kind, error] of [
	['a generic network error', new TypeError('fetch failed')],
	['connection refused', new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:443') })],
	['a timeout', new DOMException('This operation was aborted', 'AbortError')],
	['a socket error carrying a code', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })],
	['a body cut off mid-stream', new TypeError('terminated')],
	['a browser network error', new TypeError('Failed to fetch')],
	['a Firefox network error', new TypeError('NetworkError when attempting to fetch resource.')],
	['a Safari network error', new TypeError('Load failed')]
]) {
	runTestCase(`T27 ${kind} at start-up is reported as an unreachable endpoint, with its cause`, async () => {
		const endpoint = makeEndpoint([{ error }]);
		const failure = await rejection(login({ ...BASE_OPTIONS, fetchImpl: endpoint.fetchImpl }));
		assert.ok(failure.message.startsWith('Keycloak token login could not reach the token endpoint ('), failure.message);
		assert.equal(failure.cause, error);
	});
}

for (const [kind, error, rendered] of [
	['a thrown non-Error value', 'boom', 'string: boom'],
	['a RangeError (a transport bug)', new RangeError('transport bug'), 'RangeError: transport bug'],
	[
		'a TypeError that is not a network error',
		new TypeError('init.body is not a function'),
		'TypeError: init.body is not a function'
	],
	['a plain Error with no socket code', new Error('unexpected'), 'Error: unexpected']
]) {
	runTestCase(`E1 ${kind} is NOT reported as an unreachable endpoint, but typed, with its cause`, async () => {
		const endpoint = makeEndpoint([{ error }]);
		const failure = await rejection(login({ ...BASE_OPTIONS, fetchImpl: endpoint.fetchImpl }));
		assert.ok(failure instanceof KeycloakAuthenticationError);
		assert.equal(failure.message, `Keycloak token login failed (${rendered})`);
		assert.equal(failure.cause, error);
	});
}

runTestCase('E1 a non-network error on the refresh path is typed as a failed refresh, not as unreachable', async () => {
	const harness = await makeHarness([token('acc-1'), { error: new RangeError('transport bug') }]);
	harness.clock.advance(400);
	const error = await rejection(harness.provider.getAuthorizationMetadata());
	assert.equal(error.message, 'Keycloak token refresh failed (RangeError: transport bug)');
	assert.ok(error.cause instanceof RangeError);
});

runTestCase('E1 a body that fails to read with a socket error is reported as unreachable', async () => {
	const cause = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
	const bodyError = new TypeError('terminated', { cause });
	const fetchImpl = async () => ({
		status: 200,
		text: async () => {
			throw bodyError;
		}
	});
	const failure = await rejection(login({ ...BASE_OPTIONS, fetchImpl: /** @type {any} */ (fetchImpl) }));
	assert.equal(
		failure.message,
		'Keycloak token login could not reach the token endpoint (TypeError: terminated (other side closed))'
	);
	assert.equal(failure.cause, bodyError);
});

runTestCase('T27 the cause of a fetch failure is named in the message', async () => {
	const endpoint = makeEndpoint([
		{ error: new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:443') }) }
	]);
	const failure = await rejection(login({ ...BASE_OPTIONS, fetchImpl: endpoint.fetchImpl }));
	assert.equal(
		failure.message,
		'Keycloak token login could not reach the token endpoint (TypeError: fetch failed (connect ECONNREFUSED 127.0.0.1:443))'
	);
});

runTestCase('T28 a 200 non-JSON body at start-up is reported as not JSON', async () => {
	const endpoint = makeEndpoint([{ body: '<<<not-json>>>' }]);
	const failure = await rejection(login({ ...BASE_OPTIONS, fetchImpl: endpoint.fetchImpl }));
	assert.equal(failure.message, 'Keycloak token login returned status 200 with a body that is not JSON');
	assert.ok(failure.cause instanceof SyntaxError);
});

for (const [body, typeName] of [
	['[1]', 'array'],
	['null', 'null'],
	['"text"', 'string'],
	['42', 'number'],
	['true', 'boolean']
]) {
	runTestCase(`T29 a JSON ${typeName} at start-up is not an object`, async () => {
		const endpoint = makeEndpoint([{ body }]);
		const failure = await rejection(login({ ...BASE_OPTIONS, fetchImpl: endpoint.fetchImpl }));
		assert.equal(failure.message, `Keycloak token login returned a JSON ${typeName} instead of an object`);
	});
}

runTestCase('T30 a huge error body is truncated', async () => {
	const endpoint = makeEndpoint([{ status: 502, body: `<html>${'x'.repeat(10_000)}</html>` }]);
	const failure = await rejection(login({ ...BASE_OPTIONS, fetchImpl: endpoint.fetchImpl }));
	assert.ok(failure.message.length < 500 + 200, String(failure.message.length));
	assert.ok(failure.message.startsWith('Keycloak token login failed with status 502: <html>xxx'), failure.message);
});

runTestCase('T31 a body without access_token names its fields, never their values', async () => {
	const endpoint = makeEndpoint([{ body: { refresh_token: 'secret-offline-token-77', expires_in: 300 } }]);
	const failure = await rejection(login({ ...BASE_OPTIONS, fetchImpl: endpoint.fetchImpl }));
	assert.ok(failure.message.includes("the fields ['expires_in', 'refresh_token']"), failure.message);
	assert.ok(!failure.message.includes('secret-offline-token-77'), failure.message);
});

runTestCase('T31 an empty or non-string access_token is refused like a missing one', async () => {
	for (const accessToken of ['', 42, null]) {
		const endpoint = makeEndpoint([{ body: { access_token: accessToken, refresh_token: 'off-1' } }]);
		const failure = await rejection(login({ ...BASE_OPTIONS, fetchImpl: endpoint.fetchImpl }));
		assert.ok(failure.message.includes('did not contain an access_token'), failure.message);
	}
});

runTestCase('T32 a non-numeric expires_in on refresh changes no state', async () => {
	for (const expiresIn of ['soon', null, true, '   ', { seconds: 300 }]) {
		const harness = await makeHarness([token('acc-1'), token('acc-2', { expiresIn, refreshToken: 'off-2' })]);
		harness.clock.advance(280);
		await harness.provider.getAuthorizationMetadata();
		assert.equal(harness.provider.getAccessToken(), 'acc-1');
		assert.equal(harness.provider.refreshToken, 'off-1');
		assert.equal(harness.provider.expiresAtInS, 1300);
		assert.ok(harness.log.warn[0].includes('non-numeric expires_in (value withheld)'), harness.log.warn[0]);
	}
});

runTestCase('T33 a numeric-string expires_in is accepted', async () => {
	const harness = await makeHarness([token('acc-1', { expiresIn: '300' })]);
	assert.equal(harness.provider.expiresAtInS, 1300);
});

runTestCase('T34 a negative expires_in is already expired; an absent one is 0', async () => {
	const harness = await makeHarness([token('acc-1', { expiresIn: -50 })]);
	assert.equal(harness.provider.expiresAtInS, 1000);
	const absent = await makeHarness([{ body: { access_token: 'acc-1', refresh_token: 'off-1' } }]);
	assert.equal(absent.provider.expiresAtInS, 1000);
});

runTestCase('T35 a refresh without a new refresh token keeps the previous one', async () => {
	const harness = await makeHarness([
		token('acc-1', { refreshToken: 'off-1' }),
		token('acc-2', { refreshToken: null }),
		token('acc-3', { refreshToken: '' })
	]);
	harness.clock.advance(280);
	await harness.provider.getAuthorizationMetadata();
	harness.clock.advance(280);
	await harness.provider.getAuthorizationMetadata();
	assert.deepEqual(
		harness.endpoint.requests.slice(1).map((request) => request.form.refresh_token),
		['off-1', 'off-1']
	);
	assert.equal(harness.provider.getAccessToken(), 'acc-3');
});

runTestCase('T36 the grant forms, the URL and the headers are exact', async () => {
	const harness = await makeHarness([token('acc-1'), token('acc-2')], {
		keycloakUrl: 'https://auth.example.com/auth///'
	});
	harness.clock.advance(280);
	await harness.provider.getAuthorizationMetadata();
	const [loginRequest, refreshRequest] = harness.endpoint.requests;
	assert.deepEqual(loginRequest.form, {
		grant_type: 'password',
		client_id: 'ondewo-nlu-cai-sdk-public',
		username: 'tech-user@example.com',
		password: 'super-secret',
		scope: 'offline_access'
	});
	assert.deepEqual(refreshRequest.form, {
		grant_type: 'refresh_token',
		client_id: 'ondewo-nlu-cai-sdk-public',
		refresh_token: 'off-1'
	});
	for (const request of harness.endpoint.requests) {
		assert.equal(request.url, EXPECTED_TOKEN_ENDPOINT);
		assert.equal(request.init.method, 'POST');
		assert.deepEqual(request.init.headers, {
			'Content-Type': 'application/x-www-form-urlencoded',
			Accept: 'application/json'
		});
		assert.ok(request.init.signal instanceof AbortSignal);
	}
});

runTestCase('T36 the token call is aborted after exactly 10 s', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		/** @type {AbortSignal | undefined} */
		let signal;
		/**
		 * A token endpoint that never answers until the request is aborted.
		 * @param {string} _url
		 *   Unused.
		 * @param {any} init
		 *   The request init carrying the abort signal.
		 * @returns {Promise<never>}
		 *   Rejects with the abort reason.
		 */
		const hangingFetch = (_url, init) => {
			signal = init.signal;
			return new Promise((_resolve, reject) => {
				init.signal.addEventListener('abort', () => reject(init.signal.reason));
			});
		};
		const pending = rejection(login({ ...BASE_OPTIONS, fetchImpl: hangingFetch }));
		mock.timers.tick(9_999);
		assert.equal(/** @type {AbortSignal} */ (signal).aborted, false);
		mock.timers.tick(1);
		assert.equal(/** @type {AbortSignal} */ (signal).aborted, true);
		const failure = await pending;
		assert.ok(failure.message.includes('could not reach the token endpoint (AbortError'), failure.message);
	} finally {
		mock.timers.reset();
	}
});

runTestCase('the realm is URL-encoded into the token endpoint path', async () => {
	const endpoint = makeEndpoint([token('acc-1')]);
	const provider = await login({ ...BASE_OPTIONS, realm: 'ondewo/ccai platform', fetchImpl: endpoint.fetchImpl });
	assert.equal(
		endpoint.requests[0].url,
		'https://auth.example.com/auth/realms/ondewo%2Fccai%20platform/protocol/openid-connect/token'
	);
	provider.stop();
});

runTestCase(
	'S3 a password login without a usable refresh_token is accepted and keeps the previous (none)',
	async () => {
		for (const refreshToken of [undefined, '', 12345]) {
			const endpoint = makeEndpoint([
				{ body: { access_token: 'acc-1', expires_in: 300, refresh_token: refreshToken } },
				REFUSED
			]);
			const provider = await login({ ...BASE_OPTIONS, fetchImpl: endpoint.fetchImpl, startBackgroundRefresh: false });
			assert.equal(provider.getAccessToken(), 'acc-1');
			assert.equal(provider.refreshToken, null);
			// The renewal sends the (empty) refresh token and never falls back to a password grant.
			await provider.refresh().catch(() => undefined);
			assert.deepEqual(endpoint.grants(), ['password', 'refresh_token']);
			assert.equal(endpoint.requests[1].form.refresh_token, '');
			provider.stop();
		}
	}
);

runTestCase('T37 no credential reaches a log line or an error message', async () => {
	/** @type {string[]} */
	const secrets = ['pw-never-logged-5d1c', 'acc-secret-1', 'off-secret-1', 'acc-secret-2'];
	const harness = await makeHarness(
		[
			token('acc-secret-1', { refreshToken: 'off-secret-1' }),
			REFUSED,
			token('acc-secret-2', { refreshToken: 'off-secret-1' })
		],
		{ password: 'pw-never-logged-5d1c' }
	);
	await runLoop(harness, 2);
	/** @type {string} */
	const logged = [...harness.log.warn, ...harness.log.info, ...harness.log.debug].join('\n');
	assert.ok(logged.includes('refresh failed (attempt 1)'), logged);
	assert.ok(logged.includes('recovered'), logged);
	/** @type {string[]} */
	const texts = [logged, JSON.stringify(harness.provider), inspect(harness.provider)];
	// Every error message the catalogue can produce, against the same credentials.
	for (const failure of [REFUSED, { body: '<html/>' }, { body: '[]' }, { body: { refresh_token: 'off-secret-1' } }]) {
		const endpoint = makeEndpoint([failure]);
		texts.push(
			(await rejection(login({ ...BASE_OPTIONS, password: 'pw-never-logged-5d1c', fetchImpl: endpoint.fetchImpl })))
				.message
		);
	}
	const expired = await makeHarness([token('acc-secret-1', { refreshToken: 'off-secret-1' }), REFUSED], {
		password: 'pw-never-logged-5d1c'
	});
	expired.clock.advance(299);
	await expired.provider.getAuthorizationMetadata();
	expired.clock.advance(2);
	texts.push((await rejection(expired.provider.getAuthorizationMetadata())).message, ...expired.log.warn);
	for (const text of texts) {
		for (const secret of secrets) {
			assert.ok(!text.includes(secret), `${secret} leaked into: ${text}`);
		}
	}
});

runTestCase('logging the provider never prints a token: toJSON and util.inspect redact both', async () => {
	const endpoint = makeEndpoint([token('secret-access-token', { refreshToken: 'secret-offline-token' })]);
	const provider = await login({ ...BASE_OPTIONS, fetchImpl: endpoint.fetchImpl });
	try {
		for (const rendered of [JSON.stringify(provider), inspect(provider), inspect({ nested: provider })]) {
			assert.ok(!rendered.includes('secret-access-token'), rendered);
			assert.ok(!rendered.includes('secret-offline-token'), rendered);
			assert.ok(!rendered.includes('super-secret'), rendered);
			assert.ok(rendered.includes('***REDACTED***'), rendered);
		}
		assert.deepEqual(JSON.parse(JSON.stringify(provider)), {
			tokenEndpoint: EXPECTED_TOKEN_ENDPOINT,
			clientId: BASE_OPTIONS.clientId,
			accessToken: '***REDACTED***',
			refreshToken: '***REDACTED***',
			stopped: false
		});
		assert.equal(provider.getAuthorizationHeader(), 'Bearer secret-access-token');
	} finally {
		provider.stop();
	}
});

runTestCase('an absent or empty token renders as is, not as ***REDACTED***', () => {
	const provider = new OfflineTokenProvider({ ...BASE_OPTIONS });
	assert.equal(provider.toJSON().accessToken, null);
	assert.equal(provider.toJSON().refreshToken, null);
	provider.accessToken = '';
	provider.refreshToken = '';
	assert.equal(provider.toJSON().accessToken, '');
	assert.equal(provider.toJSON().refreshToken, '');
});

// endregion

// region G. stop / close

runTestCase('T38 stop twice on a provider without a loop is safe', async () => {
	const harness = await makeHarness([token('acc-1')]);
	harness.provider.stop();
	harness.provider.stop();
	await harness.provider.close();
	assert.equal(harness.provider.stopped, true);
	assert.equal(harness.provider.loopPromise, null);
});

runTestCase('T39 stop and close from inside the loop (a refresh-error handler) never deadlock', async () => {
	const harness = await makeHarness([token('acc-1'), UNAVAILABLE], {}, { fallback: UNAVAILABLE });
	/** @type {unknown[]} */
	const seen = [];
	harness.provider.onRefreshError((error) => {
		seen.push(error);
		harness.provider.stop();
		void harness.provider.close();
	});
	await runLoop(harness, 100);
	assert.equal(seen.length, 1);
	assert.ok(seen[0] instanceof KeycloakAuthenticationError);
	assert.deepEqual(harness.endpoint.grants(), ['password', 'refresh_token']);
	await harness.provider.close();
});

runTestCase('T39 after stop the lazy path still refreshes on demand', async () => {
	const harness = await makeHarness([token('acc-1'), token('acc-2')]);
	harness.provider.stop();
	harness.clock.advance(280);
	assert.deepEqual(await harness.provider.getAuthorizationMetadata(), { authorization: 'Bearer acc-2' });
});

runTestCase('T40 close() gives up waiting for a stuck loop instead of hanging', async () => {
	keycloakTiming.closeTimeoutInS = 0.02;
	try {
		const harness = await makeHarness([token('acc-1')]);
		// A wait that never resolves models a refresh stuck for ever.
		harness.provider.waitImpl = () => new Promise(() => {});
		harness.provider.startRefreshLoop();
		/** @type {number} */
		const started = performance.now();
		await harness.provider.close();
		assert.ok(performance.now() - started < 1000);
		assert.equal(harness.provider.stopped, true);
	} finally {
		restoreTiming();
	}
});

runTestCase('close() awaits a loop that exits on the stop', async () => {
	const endpoint = makeEndpoint([token('acc-1')]);
	const provider = await login({ ...BASE_OPTIONS, fetchImpl: endpoint.fetchImpl });
	await provider.close();
	assert.equal(provider.stopped, true);
	assert.equal(endpoint.requests.length, 1);
});

runTestCase('a broken wait seam cannot become an unhandled rejection', async () => {
	const harness = await makeHarness([token('acc-1')]);
	harness.provider.waitImpl = () => Promise.reject(new Error('broken seam'));
	harness.provider.startRefreshLoop();
	await harness.provider.loopPromise;
	assert.equal(harness.log.warn.length, 1);
	assert.ok(harness.log.warn[0].includes('stopped unexpectedly (Error: broken seam)'), harness.log.warn[0]);
});

runTestCase('the real wait is unref-ed, capped for a huge expiry, and resolves true once stopped', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		const signal = new _internal.StopSignal();
		/** @type {boolean | undefined} */
		let outcome;
		void signal.wait(1e12).then((stopped) => {
			outcome = stopped;
		});
		// 1e12 s would overflow setTimeout into a 1 ms hot loop; it is capped at 2^31 - 1 ms instead.
		mock.timers.tick(2147483646);
		await new Promise((resolve) => process.nextTick(resolve));
		assert.equal(outcome, undefined);
		mock.timers.tick(1);
		await new Promise((resolve) => process.nextTick(resolve));
		assert.equal(outcome, false);
		signal.fire();
		signal.fire();
		assert.equal(await signal.wait(1), true);
	} finally {
		mock.timers.reset();
	}
	const endpoint = makeEndpoint([token('acc-1')]);
	const provider = await login({ ...BASE_OPTIONS, fetchImpl: endpoint.fetchImpl });
	// The real loop is now sleeping ~270 s on an unref-ed timer: it must not hold the process open, and
	// stop() must end it at once (this test would otherwise time out).
	provider.stop();
	await provider.loopPromise;
});

runTestCase('T18 a provider sleeping in its real loop is still garbage-collectable', async () => {
	const { setFlagsFromString } = require('node:v8');
	const { runInNewContext } = require('node:vm');
	setFlagsFromString('--expose-gc');
	/** @type {() => void} */
	const collectGarbage = runInNewContext('gc');
	clearKeycloakTokenProviders();
	/**
	 * Build a provider, start its real loop (now asleep ~270 s) and keep ONLY weak references to it.
	 * @returns {Promise<{ provider: WeakRef<ProviderInstance>, key: string }>}
	 *   A weak reference to it, and its registry key.
	 */
	const startAndDrop = async () => {
		const endpoint = makeEndpoint([token('acc-1')]);
		const options = { ...BASE_OPTIONS, fetchImpl: endpoint.fetchImpl, logger: makeLogger().logger };
		const provider = /** @type {ProviderInstance} */ (await getKeycloakTokenProvider(options));
		assert.notEqual(provider.loopPromise, null);
		return { provider: new WeakRef(provider), key: await providerRegistryKey(options) };
	};
	const { provider, key } = await startAndDrop();
	for (
		let round = 0;
		round < 20 && (provider.deref() !== undefined || _internal.providerRegistry.has(key));
		round += 1
	) {
		await new Promise((resolve) => setTimeout(resolve, 10));
		collectGarbage();
	}
	assert.equal(provider.deref(), undefined, 'the pending loop kept the provider alive');
	// The FinalizationRegistry callback dropped the dead slot as well.
	assert.equal(_internal.providerRegistry.has(key), false);
});

runTestCase('the waitImpl option replaces the real wait of the background loop', async () => {
	const clock = makeClock();
	const scheduler = makeScheduler(clock, 0);
	const endpoint = makeEndpoint([token('acc-1')]);
	const provider = await login({
		...BASE_OPTIONS,
		fetchImpl: endpoint.fetchImpl,
		nowInMs: clock.nowInMs,
		waitImpl: scheduler.waitImpl
	});
	await provider.loopPromise;
	assert.deepEqual(scheduler.waits, [270]);
});

// endregion

// region H. the real worker end to end

runTestCase('T41 the real timer loop survives four failures and recovers', async () => {
	Object.assign(keycloakTiming, {
		expiryLeewayInS: 0.05,
		minRefreshDelayInS: 0.01,
		retryBaseDelayInS: 0.05,
		retryMaxDelayInS: 0.05
	});
	try {
		const endpoint = makeEndpoint([
			token('acc-1', { expiresIn: 0.1 }),
			{ error: new TypeError('fetch failed') },
			UNAVAILABLE,
			{ error: new Error('generic') },
			token('acc-ok', { expiresIn: 3600 })
		]);
		const provider = await login({ ...BASE_OPTIONS, fetchImpl: endpoint.fetchImpl, logger: makeLogger().logger });
		/** @type {boolean} */
		let loopExited = false;
		void (
			/** @type {Promise<void>} */ (provider.loopPromise).then(() => {
				loopExited = true;
			})
		);
		/** @type {number} */
		const deadline = performance.now() + 10_000;
		while (provider.getAccessToken() !== 'acc-ok' && performance.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(provider.getAccessToken(), 'acc-ok');
		assert.equal(loopExited, false);
		assert.deepEqual(endpoint.grants(), ['password', ...Array(4).fill('refresh_token')]);
		await provider.close();
		assert.equal(loopExited, true);
	} finally {
		restoreTiming();
	}
});

// endregion

// region I. offline-token start-up

runTestCase('T42 start-up with a handed-off token is ONE refresh grant without a password', async () => {
	const endpoint = makeEndpoint([token('acc-1')]);
	const provider = await login({
		keycloakUrl: BASE_OPTIONS.keycloakUrl,
		realm: BASE_OPTIONS.realm,
		clientId: BASE_OPTIONS.clientId,
		username: BASE_OPTIONS.username,
		refreshToken: 'off-handed-0',
		fetchImpl: endpoint.fetchImpl,
		startBackgroundRefresh: false
	});
	assert.deepEqual(endpoint.requests[0].form, {
		grant_type: 'refresh_token',
		client_id: 'ondewo-nlu-cai-sdk-public',
		refresh_token: 'off-handed-0'
	});
	assert.ok(!('password' in endpoint.requests[0].form));
	assert.equal(provider.getAccessToken(), 'acc-1');
	// The start-up answer rotated the token, so the provider now holds the new one.
	assert.equal(provider.refreshToken, 'off-1');
});

runTestCase('T43 a password configured alongside the token is never sent', async () => {
	const harness = await makeHarness([token('acc-1'), UNAVAILABLE, token('acc-3')], { refreshToken: 'off-handed-0' });
	harness.clock.advance(280);
	await harness.provider.getAuthorizationMetadata();
	harness.clock.advance(5);
	await harness.provider.getAuthorizationMetadata();
	assert.deepEqual(harness.endpoint.grants(), ['refresh_token', 'refresh_token', 'refresh_token']);
	assert.ok(harness.endpoint.requests.every((request) => !('password' in request.form)));
	assert.equal(harness.provider.getAccessToken(), 'acc-3');
});

runTestCase('T44 a refused start-up token raises and never falls back to the password', async () => {
	const endpoint = makeEndpoint([REFUSED]);
	const failure = await rejection(
		login({ ...BASE_OPTIONS, refreshToken: 'off-handed-0', fetchImpl: endpoint.fetchImpl })
	);
	assert.ok(failure.message.startsWith('Keycloak token refresh failed with status 400'), failure.message);
	assert.deepEqual(endpoint.grants(), ['refresh_token']);
});

runTestCase('T45 a token rotated at start-up is the one the next refresh sends', async () => {
	const harness = await makeHarness([token('acc-1', { refreshToken: 'off-rotated' }), token('acc-2')], {
		refreshToken: 'off-handed-0'
	});
	harness.clock.advance(280);
	await harness.provider.getAuthorizationMetadata();
	assert.equal(harness.endpoint.requests[1].form.refresh_token, 'off-rotated');
});

runTestCase('T45 a start-up answer without a refresh token keeps the handed-off one', async () => {
	const harness = await makeHarness([token('acc-1', { refreshToken: null })], { refreshToken: 'off-handed-0' });
	assert.equal(harness.provider.refreshToken, 'off-handed-0');
});

runTestCase('T46 the deadline is armed on the token path and stops the loop by itself', async () => {
	const harness = await makeHarness([token('acc-1')], { refreshToken: 'off-handed-0', tokenExpirationInS: 200 });
	assert.equal(harness.provider.deadlineInS, 1200);
	await runLoop(harness, 1000);
	assert.ok(harness.clock.nowInS() <= 1201);
	assert.equal(harness.provider.stopped, true);
	assert.deepEqual(harness.endpoint.grants(), ['refresh_token']);
	// R1: after the deadline the lazy path serves the token as is and sends nothing.
	harness.clock.advance(1000);
	assert.deepEqual(await harness.provider.getAuthorizationMetadata(), { authorization: 'Bearer acc-1' });
	assert.equal(harness.endpoint.requests.length, 1);
});

runTestCase('T47 the loop survives a failing offline token', async () => {
	const harness = await makeHarness([token('acc-1'), REFUSED, REFUSED, token('acc-4')], {
		refreshToken: 'off-handed-0'
	});
	await runLoop(harness, 3);
	assert.deepEqual(harness.endpoint.grants(), Array(4).fill('refresh_token'));
	assert.equal(harness.provider.getAccessToken(), 'acc-4');
});

// endregion

// region J. registry

/**
 * Options for the shared registry with a given endpoint (no background loop).
 *
 * @param {FakeEndpoint} endpoint
 *   The endpoint.
 * @param {Record<string, unknown>} [overrides]
 *   Overridden fields.
 * @returns {any}
 *   The options.
 */
function registryOptions(endpoint, overrides = {}) {
	return { ...BASE_OPTIONS, fetchImpl: endpoint.fetchImpl, startBackgroundRefresh: false, ...overrides };
}

runTestCase('T48 the same credentials share ONE provider, also on a concurrent first use', async () => {
	clearKeycloakTokenProviders();
	const endpoint = makeEndpoint([token('acc-1')]);
	const [first, second] = await Promise.all([
		getKeycloakTokenProvider(registryOptions(endpoint)),
		getKeycloakTokenProvider(registryOptions(endpoint))
	]);
	const third = await getKeycloakTokenProvider(registryOptions(endpoint));
	assert.ok(first instanceof OfflineTokenProvider);
	assert.equal(first, second);
	assert.equal(first, third);
	assert.equal(endpoint.requests.length, 1);
	clearKeycloakTokenProviders();
});

runTestCase('T49 a different username, password, realm or URL gets its own provider', async () => {
	clearKeycloakTokenProviders();
	const endpoint = makeEndpoint([], { fallback: token('acc-1') });
	const base = await getKeycloakTokenProvider(registryOptions(endpoint));
	for (const override of [
		{ username: 'other-user' },
		{ password: 'other-password' },
		{ realm: 'other-realm' },
		{ keycloakUrl: 'https://other.example.com/auth' },
		{ tokenExpirationInS: 60 },
		{ keycloakVerifySsl: false }
	]) {
		assert.notEqual(
			await getKeycloakTokenProvider(registryOptions(endpoint, override)),
			base,
			JSON.stringify(override)
		);
	}
	clearKeycloakTokenProviders();
});

runTestCase('T50 50 configs created and dropped in a loop get 50 logins with exactly their usernames', async () => {
	clearKeycloakTokenProviders();
	const endpoint = makeEndpoint([], { fallback: token('acc-1') });
	/** @type {string[]} */
	const usernames = Array.from({ length: 50 }, (_unused, index) => `user-${index}`);
	for (const username of usernames) {
		await getKeycloakTokenProvider(registryOptions(endpoint, { username }));
	}
	assert.deepEqual(
		endpoint.requests.map((request) => request.form.username),
		usernames
	);
	clearKeycloakTokenProviders();
});

runTestCase('T51 two token-only configs with empty passwords never share a provider', async () => {
	clearKeycloakTokenProviders();
	const endpoint = makeEndpoint([], { fallback: token('acc-1') });
	const tenantA = await getKeycloakTokenProvider(
		registryOptions(endpoint, { password: '', refreshToken: 'off-tenant-a' })
	);
	const tenantB = await getKeycloakTokenProvider(
		registryOptions(endpoint, { password: '', refreshToken: 'off-tenant-b' })
	);
	assert.notEqual(tenantA, tenantB);
	assert.deepEqual(
		endpoint.requests.map((request) => request.form.refresh_token),
		['off-tenant-a', 'off-tenant-b']
	);
	clearKeycloakTokenProviders();
});

runTestCase('T52 T53 the registry key is a 64-hex SHA-256 holding neither the token nor the password', async () => {
	/** @type {any} */
	const options = { ...BASE_OPTIONS, password: 'pw-in-key-check', refreshToken: 'off-in-key-check' };
	const key = await providerRegistryKey(options);
	assert.match(key, /^[0-9a-f]{64}$/);
	assert.ok(!key.includes('off-in-key-check'));
	assert.ok(!key.includes('pw-in-key-check'));
	// Absent and null optional fields hash like empty ones, and every field takes part.
	assert.equal(
		await providerRegistryKey(/** @type {any} */ ({ ...options, password: null, tokenExpirationInS: null })),
		await providerRegistryKey(/** @type {any} */ ({ ...options, password: undefined }))
	);
	assert.equal(
		await providerRegistryKey(/** @type {any} */ ({ ...options, refreshToken: null })),
		await providerRegistryKey(/** @type {any} */ ({ ...options, refreshToken: undefined }))
	);
	assert.notEqual(await providerRegistryKey({ ...options, refreshToken: 'off-other' }), key);
	assert.notEqual(await providerRegistryKey({ ...options, tokenExpirationInS: 5 }), key);
	// The spec's derivation, recomputed independently.
	const { createHash } = require('node:crypto');
	const expected = createHash('sha256')
		.update(
			[
				BASE_OPTIONS.keycloakUrl,
				BASE_OPTIONS.realm,
				BASE_OPTIONS.clientId,
				BASE_OPTIONS.username,
				'pw-in-key-check',
				'',
				'True',
				'off-in-key-check'
			].join('\0')
		)
		.digest('hex');
	assert.equal(key, expected);
});

runTestCase('T54 a provider whose deadline closed is still handed out (no second login), as in python', async () => {
	clearKeycloakTokenProviders();
	const clock = makeClock();
	const endpoint = makeEndpoint([], { clock, fallback: token('acc-1') });
	const options = registryOptions(endpoint, { nowInMs: clock.nowInMs, tokenExpirationInS: 200 });
	const first = /** @type {ProviderInstance} */ (await getKeycloakTokenProvider(options));
	await runLoop(/** @type {any} */ ({ provider: first, clock, waits: [] }), 1000);
	assert.equal(first.stopped, true);
	assert.equal(first.closed, false);
	assert.equal(await getKeycloakTokenProvider(options), first);
	assert.deepEqual(endpoint.grants(), ['password']);
	clearKeycloakTokenProviders();
	assert.equal(first.closed, true);
});

runTestCase('T54 a stopped provider is never handed to a new client', async () => {
	clearKeycloakTokenProviders();
	const endpoint = makeEndpoint([], { fallback: token('acc-1') });
	const first = /** @type {ProviderInstance} */ (await getKeycloakTokenProvider(registryOptions(endpoint)));
	first.stop();
	const second = await getKeycloakTokenProvider(registryOptions(endpoint));
	assert.notEqual(second, first);
	assert.equal(endpoint.requests.length, 2);
	clearKeycloakTokenProviders();
});

runTestCase('a failed creation is not cached, and concurrent waiters all see the failure', async () => {
	clearKeycloakTokenProviders();
	// The refusal is slow, so both callers provably share the ONE creation in flight.
	const endpoint = makeEndpoint([{ ...REFUSED, delayMs: 30 }, token('acc-1')]);
	const results = await Promise.allSettled([
		getKeycloakTokenProvider(registryOptions(endpoint)),
		getKeycloakTokenProvider(registryOptions(endpoint))
	]);
	assert.deepEqual(
		results.map((result) => result.status),
		['rejected', 'rejected']
	);
	assert.ok(await getKeycloakTokenProvider(registryOptions(endpoint)));
	assert.equal(endpoint.requests.length, 2);
	clearKeycloakTokenProviders();
});

runTestCase('a failure after the registry was cleared leaves the newer slot alone', async () => {
	clearKeycloakTokenProviders();
	const endpoint = makeEndpoint([{ ...REFUSED, delayMs: 20 }, token('acc-1')]);
	const failing = getKeycloakTokenProvider(registryOptions(endpoint));
	// Let the first creation reach the network, then clear and start a second one under the same key.
	await new Promise((resolve) => setTimeout(resolve, 5));
	clearKeycloakTokenProviders();
	const replacement = getKeycloakTokenProvider(registryOptions(endpoint));
	await assert.rejects(failing, KeycloakAuthenticationError);
	const provider = await replacement;
	assert.equal(await getKeycloakTokenProvider(registryOptions(endpoint)), provider);
	clearKeycloakTokenProviders();
});

runTestCase('a collected provider is recreated, and its slot is dropped by the finalizer callback', async () => {
	clearKeycloakTokenProviders();
	const endpoint = makeEndpoint([], { fallback: token('acc-1') });
	const options = registryOptions(endpoint);
	const key = await providerRegistryKey(options);
	const collected = { deref: () => undefined };
	_internal.providerRegistry.set(key, { pending: null, ref: collected });
	const provider = await getKeycloakTokenProvider(options);
	assert.ok(provider instanceof OfflineTokenProvider);
	assert.equal(endpoint.requests.length, 1);
	// The finalizer callback: a live slot, a pending slot and an unknown key are left alone ...
	_internal.forgetCollectedProvider(key);
	_internal.forgetCollectedProvider('unknown-key');
	_internal.providerRegistry.set('pending-key', { pending: Promise.resolve(/** @type {any} */ (null)), ref: null });
	_internal.forgetCollectedProvider('pending-key');
	assert.ok(_internal.providerRegistry.has(key));
	assert.ok(_internal.providerRegistry.has('pending-key'));
	// ... and a collected slot is dropped.
	_internal.providerRegistry.set('collected-key', { pending: null, ref: collected });
	_internal.forgetCollectedProvider('collected-key');
	assert.ok(!_internal.providerRegistry.has('collected-key'));
	// clearKeycloakTokenProviders stops what is alive and forgets every slot, pending or collected.
	_internal.providerRegistry.set('collected-key', { pending: null, ref: collected });
	clearKeycloakTokenProviders();
	assert.equal(_internal.providerRegistry.size, 0);
	assert.equal(/** @type {ProviderInstance} */ (provider).stopped, true);
});

// endregion

// region K. config

runTestCase('T55 no positional surface gained a parameter (options objects everywhere)', () => {
	assert.equal(OfflineTokenProvider.length, 1);
	assert.equal(OfflineTokenProvider.prototype.bootstrap.length, 2);
	assert.equal(login.length, 1);
	assert.equal(getKeycloakTokenProvider.length, 1);
});

runTestCase('T56 T60 a token-only config constructs and reaches the provider with that token', async () => {
	clearKeycloakTokenProviders();
	const endpoint = makeEndpoint([token('acc-1')]);
	const provider = await getKeycloakTokenProvider(
		registryOptions(endpoint, { password: undefined, refreshToken: 'off-token-only' })
	);
	assert.ok(provider instanceof OfflineTokenProvider);
	assert.deepEqual(endpoint.requests[0].form, {
		grant_type: 'refresh_token',
		client_id: 'ondewo-nlu-cai-sdk-public',
		refresh_token: 'off-token-only'
	});
	clearKeycloakTokenProviders();
});

runTestCase('T57 a Keycloak config with neither a password nor a token is refused', async () => {
	for (const call of [login, getKeycloakTokenProvider]) {
		for (const credentials of [{}, { password: '' }, { password: '', refreshToken: '' }, { password: null }]) {
			/** @type {any} */
			const options = { ...BASE_OPTIONS, password: undefined, ...credentials, fetchImpl: makeEndpoint([]).fetchImpl };
			await assert.rejects(
				() => call(options),
				(error) =>
					error instanceof TokenError &&
					error.message.includes('`password`') &&
					error.message.includes('`refreshToken`') &&
					error.message.includes('refresh_token')
			);
		}
	}
});

runTestCase('T58 a password config is unchanged', async () => {
	clearKeycloakTokenProviders();
	const endpoint = makeEndpoint([token('acc-1')]);
	const provider = await getKeycloakTokenProvider(registryOptions(endpoint));
	assert.ok(provider instanceof OfflineTokenProvider);
	assert.deepEqual(endpoint.grants(), ['password']);
	assert.equal(provider.getAuthorizationHeader(), 'Bearer acc-1');
	clearKeycloakTokenProviders();
});

runTestCase('T59 rendering the options redacts a non-empty secret and keeps an empty one empty', () => {
	const rendered = redactLoginOptions({ ...BASE_OPTIONS, refreshToken: 'off-rendered-9' });
	assert.equal(rendered.password, '***REDACTED***');
	assert.equal(rendered.refreshToken, '***REDACTED***');
	assert.equal(rendered.username, BASE_OPTIONS.username);
	assert.ok(!JSON.stringify(rendered).includes('off-rendered-9'));
	assert.ok(!JSON.stringify(rendered).includes('super-secret'));
	const empty = redactLoginOptions({ ...BASE_OPTIONS, password: '', refreshToken: '' });
	assert.equal(empty.password, '');
	assert.equal(empty.refreshToken, '');
	/** @type {Record<string, unknown>} */
	const withoutPassword = { ...BASE_OPTIONS };
	delete withoutPassword.password;
	assert.ok(!('password' in redactLoginOptions(/** @type {any} */ (withoutPassword))));
});

runTestCase('T61 a partial Keycloak triple is refused naming the three fields', async () => {
	/** @type {('keycloakUrl' | 'realm' | 'clientId')[][]} */
	const subsets = [
		['keycloakUrl'],
		['realm'],
		['clientId'],
		['keycloakUrl', 'realm'],
		['keycloakUrl', 'clientId'],
		['realm', 'clientId']
	];
	for (const call of [login, getKeycloakTokenProvider]) {
		for (const present of subsets) {
			/** @type {any} */
			const options = {
				...BASE_OPTIONS,
				keycloakUrl: '',
				realm: '',
				clientId: '',
				fetchImpl: makeEndpoint([]).fetchImpl
			};
			for (const field of present) {
				options[field] = BASE_OPTIONS[field];
			}
			await assert.rejects(
				() => call(options),
				(error) =>
					error instanceof TokenError &&
					['`keycloakUrl`', '`realm`', '`clientId`'].every((field) => error.message.includes(field))
			);
		}
	}
	// login() can only authenticate, so an absent triple is refused there too.
	await assert.rejects(() => login(/** @type {any} */ ({ username: 'u', password: 'p' })), /must be provided together/);
});

runTestCase('T62 no Keycloak triple builds no provider and sends nothing', async () => {
	const endpoint = makeEndpoint([]);
	assert.equal(await getKeycloakTokenProvider(/** @type {any} */ ({ fetchImpl: endpoint.fetchImpl })), null);
	assert.equal(
		await getKeycloakTokenProvider(
			/** @type {any} */ ({ keycloakUrl: '', realm: '', clientId: '', username: '', password: '' })
		),
		null
	);
	assert.equal(endpoint.requests.length, 0);
});

runTestCase('options are validated before any network call (missing object, non-string, empty username)', async () => {
	await assert.rejects(() => login(/** @type {any} */ (null)), /login\(\) requires an options object/);
	await assert.rejects(() => login(/** @type {any} */ (undefined)), TokenError);
	await assert.rejects(
		() => getKeycloakTokenProvider(/** @type {any} */ (null)),
		/getKeycloakTokenProvider\(\) requires/
	);
	for (const key of ['keycloakUrl', 'realm', 'clientId', 'username', 'password', 'refreshToken']) {
		await assert.rejects(
			() => login(/** @type {any} */ ({ ...BASE_OPTIONS, [key]: 42 })),
			(error) => error instanceof TokenError && error.message === `login() option "${key}" must be a string`
		);
	}
	for (const username of ['', undefined, null]) {
		await assert.rejects(
			() => login(/** @type {any} */ ({ ...BASE_OPTIONS, username })),
			(error) => error instanceof TokenError && error.message.includes('"username"')
		);
	}
});

// endregion

// region the rest of the public surface

runTestCase('getAuthorizationMetadata and getAuthorizationHeader refuse before bootstrap', async () => {
	const provider = new OfflineTokenProvider({ ...BASE_OPTIONS });
	assert.throws(
		() => provider.getAuthorizationHeader(),
		(error) => error instanceof TokenError && error.name === 'TokenError'
	);
	await assert.rejects(() => provider.getAuthorizationMetadata(), /No access token available/);
	assert.equal(provider.getAccessToken(), null);
});

runTestCase('a comfortably valid token is served without a request', async () => {
	const harness = await makeHarness([token('acc-1')]);
	harness.clock.advance(269);
	assert.deepEqual(await harness.provider.getAuthorizationMetadata(), { authorization: 'Bearer acc-1' });
	assert.equal(harness.endpoint.requests.length, 1);
});

runTestCase('the unary interceptor merges the bearer into every call, and an auth failure sends nothing', async () => {
	const harness = await makeHarness([token('acc-1'), REFUSED]);
	const interceptor = createAuthUnaryInterceptor(harness.provider);
	/** @type {Record<string, string>} */
	const metadata = { 'x-custom': 'kept' };
	const request = { getMetadata: () => metadata };
	/** @type {unknown[]} */
	const invoked = [];
	/**
	 * The next link of the interceptor chain.
	 * @param {unknown} forwarded
	 *   The request it was handed.
	 * @returns {Promise<string>}
	 *   A fake response.
	 */
	const invoker = (forwarded) => {
		invoked.push(forwarded);
		return Promise.resolve('response');
	};
	assert.equal(await interceptor.intercept(request, invoker), 'response');
	assert.deepEqual(metadata, { 'x-custom': 'kept', authorization: 'Bearer acc-1' });
	assert.deepEqual(invoked, [request]);
	harness.clock.advance(400);
	await rejection(interceptor.intercept(request, invoker));
	assert.equal(invoked.length, 1);
});

runTestCase('onRefreshError receives every failed refresh, and a throwing handler is ignored', async () => {
	const harness = await makeHarness([token('acc-1'), UNAVAILABLE, UNAVAILABLE]);
	/** @type {unknown[]} */
	const seen = [];
	harness.provider.onRefreshError((error) => {
		seen.push(error);
		throw new Error('handler bug');
	});
	harness.clock.advance(280);
	await harness.provider.getAuthorizationMetadata();
	harness.clock.advance(5);
	await harness.provider.getAuthorizationMetadata();
	assert.equal(seen.length, 2);
	assert.ok(seen.every((error) => error instanceof KeycloakAuthenticationError));
});

runTestCase('refresh() forces one refresh grant, and skips it once stopped or past the deadline', async () => {
	const harness = await makeHarness([token('acc-1'), token('acc-2'), UNAVAILABLE], { tokenExpirationInS: 100 });
	await harness.provider.refresh();
	assert.equal(harness.provider.getAccessToken(), 'acc-2');
	await rejection(harness.provider.refresh());
	assert.equal(harness.provider.consecutiveRefreshFailures, 1);
	harness.clock.advance(100);
	await harness.provider.refresh();
	harness.clock.advance(-100);
	harness.provider.stop();
	await harness.provider.refresh();
	assert.equal(harness.endpoint.requests.length, 3);
});

runTestCase('a refresh before bootstrap sends an empty refresh token and fails typed', async () => {
	const endpoint = makeEndpoint([REFUSED]);
	const provider = new OfflineTokenProvider({
		...BASE_OPTIONS,
		fetchImpl: endpoint.fetchImpl,
		logger: makeLogger().logger
	});
	await rejection(provider.refresh());
	assert.equal(endpoint.requests[0].form.refresh_token, '');
});

runTestCase('bootstrap without a password sends an empty one (direct use of the class)', async () => {
	const endpoint = makeEndpoint([token('acc-1')]);
	const provider = new OfflineTokenProvider({
		...BASE_OPTIONS,
		fetchImpl: endpoint.fetchImpl,
		startBackgroundRefresh: false
	});
	await provider.bootstrap('tech-user@example.com', undefined);
	assert.equal(endpoint.requests[0].form.password, '');
});

runTestCase('the defaults: global fetch, the monotonic performance clock, Math.random, console', async () => {
	const originalFetch = globalThis.fetch;
	const endpoint = makeEndpoint([token('global-1')]);
	globalThis.fetch = /** @type {typeof globalThis.fetch} */ (/** @type {unknown} */ (endpoint.fetchImpl));
	try {
		/** @type {number} */
		const before = performance.now() / 1000;
		const provider = await login({ ...BASE_OPTIONS, tokenExpirationInS: 3600, startBackgroundRefresh: false });
		/** @type {number} */
		const after = performance.now() / 1000;
		assert.equal(endpoint.requests[0].url, EXPECTED_TOKEN_ENDPOINT);
		assert.equal(provider.getAccessToken(), 'global-1');
		assert.ok(/** @type {number} */ (provider.deadlineInS) >= before + 3600);
		assert.ok(/** @type {number} */ (provider.deadlineInS) <= after + 3600);
		assert.equal(provider.randomFraction, Math.random);
		assert.equal(provider.logger, console);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

runTestCase(
	'keycloakVerifySsl: verified by default and when true; false attaches the insecure agent to every call',
	async () => {
		for (const keycloakVerifySsl of [undefined, true]) {
			const endpoint = makeEndpoint([token('acc-1')]);
			await login({ ...BASE_OPTIONS, fetchImpl: endpoint.fetchImpl, keycloakVerifySsl, startBackgroundRefresh: false });
			assert.equal(endpoint.requests[0].init.dispatcher, undefined);
		}
		const harness = await makeHarness([token('acc-1'), token('acc-2')], { keycloakVerifySsl: false });
		harness.clock.advance(280);
		await harness.provider.getAuthorizationMetadata();
		for (const request of harness.endpoint.requests) {
			assert.ok(request.init.dispatcher instanceof Agent);
		}
		assert.equal(harness.endpoint.requests[0].init.dispatcher, harness.endpoint.requests[1].init.dispatcher);
		assert.deepEqual(INSECURE_AGENT_OPTIONS, { connect: { rejectUnauthorized: false } });
	}
);

runTestCase('every token failure is a KeycloakAuthenticationError, still catchable as TokenError', async () => {
	const endpoint = makeEndpoint([REFUSED]);
	const failure = await rejection(login({ ...BASE_OPTIONS, fetchImpl: endpoint.fetchImpl }));
	assert.equal(failure.name, 'KeycloakAuthenticationError');
	assert.ok(failure instanceof Error);
});

// endregion
