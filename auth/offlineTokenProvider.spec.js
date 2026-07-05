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

// Unit tests for the D18 offline-token helper. The token endpoint is mocked via the injectable
// `fetchImpl` option -- there is NO network access.
//   node --test auth/offlineTokenProvider.spec.js

'use strict';

const { test: runTestCase, mock } = require('node:test');
const assert = require('node:assert/strict');

const { Agent } = require('undici');

const { login, OfflineTokenProvider, TokenError } = require('./offlineTokenProvider');

/**
 * The shared, valid base options for the public SDK client, spread into each test's `login()` call and
 * overridden per-test (e.g. a different `keycloakUrl`, an injected `fetchImpl`, or a bad `clientId`).
 *
 * @type {{
 *   keycloakUrl: string,
 *   realm: string,
 *   clientId: string,
 *   username: string,
 *   password: string
 * }}
 */
const BASE_OPTIONS = {
	keycloakUrl: 'https://auth.example.com/auth',
	realm: 'ondewo-ccai-platform',
	clientId: 'ondewo-nlu-cai-sdk-public',
	username: 'tech-user@example.com',
	password: 'super-secret'
};

/**
 * The token endpoint {@link BASE_OPTIONS} must resolve to; asserted against the URL the stub received.
 *
 * @type {string}
 */
const EXPECTED_TOKEN_ENDPOINT =
	'https://auth.example.com/auth/realms/ondewo-ccai-platform/protocol/openid-connect/token';

/**
 * A scripted token-endpoint response for the fetch stub. `status` defaults to 200; `body` is sent
 * verbatim when a string (to exercise the non-JSON path) or `JSON.stringify`-ed otherwise.
 *
 * @typedef {object} StubResponse
 * @property {number} [status]
 *     The HTTP status to report; defaults to 200.
 * @property {object | string} [body]
 *     The response body: an object that is JSON-encoded, or a raw string sent as-is.
 */

/**
 * A single request captured by the fetch stub, for post-hoc assertions on URL and body.
 *
 * @typedef {object} CapturedCall
 * @property {string} url
 *     The endpoint the stub was invoked with.
 * @property {{ method: string, headers: Record<string, string>, body: string }} init
 *     The raw `fetch` init object (method, headers, body) the source always sends.
 * @property {URLSearchParams} params
 *     The form-decoded request body, for inspecting individual fields.
 */

/**
 * Build a fake `fetch` that returns a scripted sequence of responses (one per call) and records every
 * request it received, so assertions can inspect the form-encoded body and the URL. There is NO network
 * access. Throws if invoked more times than the script provides.
 *
 * @param {StubResponse[]} responses
 *     The responses to return, in call order; each shift-ed off on use.
 * @returns {{ fetchImpl: (url: string, init: { method: string, headers: Record<string, string>, body: string }) => Promise<{ ok: boolean, status: number, text: () => Promise<string> }>, calls: CapturedCall[] }}
 *     The injectable `fetchImpl` and the live array of captured calls.
 */
function makeFetchStub(responses) {
	/** @type {CapturedCall[]} */
	const calls = [];
	/**
	 * @param {string} url
	 *     The endpoint being requested.
	 * @param {{ method: string, headers: Record<string, string>, body: string }} init
	 *     The `fetch` init whose form-encoded `body` is decoded for assertions.
	 * @returns {Promise<{ ok: boolean, status: number, text: () => Promise<string> }>}
	 *     The next scripted response.
	 */
	const fetchImpl = (url, init) => {
		calls.push({ url, init, params: new URLSearchParams(init.body) });
		const next = responses.shift();
		if (next === undefined) {
			throw new Error('fetch stub called more times than expected');
		}
		const status = next.status !== undefined ? next.status : 200;
		const bodyText = typeof next.body === 'string' ? next.body : JSON.stringify(next.body);
		return Promise.resolve({
			ok: status >= 200 && status < 300,
			status,
			text: () => Promise.resolve(bodyText)
		});
	};
	return { fetchImpl, calls };
}

/**
 * Yield to the microtask queue so an awaited refresh inside a fired timer can settle before assertions.
 *
 * @returns {Promise<void>}
 *     Resolves on the next tick of the microtask queue.
 */
function flushMicrotasks() {
	return new Promise((resolve) => {
		process.nextTick(resolve);
	});
}

runTestCase(
	'login posts ROPC + offline_access to the realm token endpoint with the public client (no secret)',
	async () => {
		const stub = makeFetchStub([{ body: { access_token: 'access-1', refresh_token: 'offline-1', expires_in: 300 } }]);

		const provider = await login({ ...BASE_OPTIONS, fetchImpl: stub.fetchImpl });

		assert.equal(stub.calls.length, 1);
		assert.equal(stub.calls[0].url, EXPECTED_TOKEN_ENDPOINT);
		assert.equal(stub.calls[0].init.method, 'POST');
		assert.equal(stub.calls[0].init.headers['Content-Type'], 'application/x-www-form-urlencoded');
		assert.equal(stub.calls[0].init.headers.Accept, 'application/json');

		const params = stub.calls[0].params;
		assert.equal(params.get('grant_type'), 'password');
		assert.equal(params.get('client_id'), 'ondewo-nlu-cai-sdk-public');
		assert.equal(params.get('username'), 'tech-user@example.com');
		assert.equal(params.get('password'), 'super-secret');
		assert.equal(params.get('scope'), 'offline_access');
		// Q1: PUBLIC client -- there must be NO client_secret on the wire.
		assert.equal(params.get('client_secret'), null);

		assert.equal(provider.getAccessToken(), 'access-1');
		assert.equal(provider.getAuthorizationHeader(), 'Bearer access-1');
		provider.stop();
	}
);

runTestCase('login tolerates a trailing slash on keycloakUrl when building the token endpoint', async () => {
	const stub = makeFetchStub([{ body: { access_token: 'access-1', refresh_token: 'offline-1', expires_in: 300 } }]);

	const provider = await login({
		...BASE_OPTIONS,
		keycloakUrl: 'https://auth.example.com/auth///',
		fetchImpl: stub.fetchImpl
	});

	assert.equal(stub.calls[0].url, EXPECTED_TOKEN_ENDPOINT);
	provider.stop();
});

runTestCase('auto-refresh exchanges the offline refresh_token for a fresh access token before expiry', async () => {
	const stub = makeFetchStub([
		{ body: { access_token: 'access-1', refresh_token: 'offline-1', expires_in: 31 } },
		{ body: { access_token: 'access-2', refresh_token: 'offline-2', expires_in: 31 } }
	]);

	// expires_in 31 - 30 skew = 1s scheduled delay; drive it deterministically via fake timers.
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		const provider = await login({ ...BASE_OPTIONS, fetchImpl: stub.fetchImpl });
		assert.equal(provider.getAccessToken(), 'access-1');

		mock.timers.tick(1000);
		await flushMicrotasks();

		assert.equal(stub.calls.length, 2);
		const refreshParams = stub.calls[1].params;
		assert.equal(refreshParams.get('grant_type'), 'refresh_token');
		assert.equal(refreshParams.get('refresh_token'), 'offline-1');
		assert.equal(refreshParams.get('client_id'), 'ondewo-nlu-cai-sdk-public');
		assert.equal(refreshParams.get('client_secret'), null);

		assert.equal(provider.getAccessToken(), 'access-2');
		assert.equal(provider.getAuthorizationHeader(), 'Bearer access-2');
		provider.stop();
	} finally {
		mock.timers.reset();
	}
});

runTestCase('the refresh loop stops after tokenExpirationInS elapses (no further renewal)', async () => {
	const stub = makeFetchStub([{ body: { access_token: 'access-1', refresh_token: 'offline-1', expires_in: 31 } }]);

	let fakeNowInMs = 1_000_000;
	/**
	 * Injectable clock returning the mutable `fakeNowInMs`, so the test can advance the wall clock past
	 * the bounded deadline independently of the mocked `setTimeout`.
	 * @type {() => number}
	 */
	const nowInMs = () => fakeNowInMs;

	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		// Bound the loop to 2s; the first refresh is armed at ~1s but the deadline passes before it fires.
		const provider = await login({
			...BASE_OPTIONS,
			fetchImpl: stub.fetchImpl,
			nowInMs,
			tokenExpirationInS: 2
		});

		// Advance the wall clock past the deadline before the timer fires.
		fakeNowInMs += 3000;
		mock.timers.tick(1000);
		await flushMicrotasks();

		// Deadline already passed -> refresh must NOT have fired; only the initial login call happened.
		assert.equal(stub.calls.length, 1);
		provider.stop();
	} finally {
		mock.timers.reset();
	}
});

runTestCase('a long deadline clamps the next refresh delay to the remaining window', async () => {
	const stub = makeFetchStub([
		{ body: { access_token: 'access-1', refresh_token: 'offline-1', expires_in: 31 } },
		{ body: { access_token: 'access-2', refresh_token: 'offline-2', expires_in: 31 } }
	]);

	const fakeNowInMs = 2_000_000;
	/**
	 * Injectable clock returning the mutable `fakeNowInMs`, so the deadline math can be driven precisely.
	 * @type {() => number}
	 */
	const nowInMs = () => fakeNowInMs;

	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		// Deadline 1000s away -> remaining window dwarfs the 1s skew delay, so the skew delay wins (Math.min).
		const provider = await login({
			...BASE_OPTIONS,
			fetchImpl: stub.fetchImpl,
			nowInMs,
			tokenExpirationInS: 1000
		});

		mock.timers.tick(1000);
		await flushMicrotasks();

		// Refresh fired within the deadline; the loop kept renewing.
		assert.equal(stub.calls.length, 2);
		assert.equal(provider.getAccessToken(), 'access-2');
		provider.stop();
	} finally {
		mock.timers.reset();
	}
});

runTestCase('login rejects a non-2xx token response with TokenError', async () => {
	const stub = makeFetchStub([{ status: 401, body: { error: 'invalid_grant' } }]);
	await assert.rejects(() => login({ ...BASE_OPTIONS, fetchImpl: stub.fetchImpl }), TokenError);
});

runTestCase('login rejects when the token response carries no refresh_token (missing offline_access)', async () => {
	const stub = makeFetchStub([{ body: { access_token: 'access-1', expires_in: 300 } }]);
	await assert.rejects(() => login({ ...BASE_OPTIONS, fetchImpl: stub.fetchImpl }), TokenError);
});

runTestCase('login validates required options', async () => {
	const stub = makeFetchStub([]);
	await assert.rejects(() => login({ ...BASE_OPTIONS, fetchImpl: stub.fetchImpl, clientId: '' }), TokenError);
});

runTestCase('getAuthorizationHeader throws before bootstrap when no token is available', () => {
	const stub = makeFetchStub([]);
	const provider = new OfflineTokenProvider({ ...BASE_OPTIONS, fetchImpl: stub.fetchImpl });
	assert.throws(() => provider.getAuthorizationHeader(), TokenError);
	assert.equal(provider.getAccessToken(), null);
});

runTestCase('login rejects a 2xx token response whose body is not valid JSON', async () => {
	const stub = makeFetchStub([{ body: '<<<not-json>>>' }]);
	await assert.rejects(() => login({ ...BASE_OPTIONS, fetchImpl: stub.fetchImpl }), TokenError);
});

runTestCase('login rejects a parseable token response that carries no access_token', async () => {
	const stub = makeFetchStub([{ body: { refresh_token: 'offline-1', expires_in: 300 } }]);
	await assert.rejects(() => login({ ...BASE_OPTIONS, fetchImpl: stub.fetchImpl }), TokenError);
});

runTestCase('login rejects a missing options object', async () => {
	// Deliberately pass invalid inputs to exercise the runtime null/undefined guard in login().
	await assert.rejects(() => login(/** @type {any} */ (null)), TokenError);
	await assert.rejects(() => login(/** @type {any} */ (undefined)), TokenError);
});

runTestCase('a failed background refresh is surfaced to onRefreshError and keeps the stale token', async () => {
	const stub = makeFetchStub([
		{ body: { access_token: 'access-1', refresh_token: 'offline-1', expires_in: 31 } },
		{ status: 500, body: 'boom' }
	]);

	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		const provider = await login({ ...BASE_OPTIONS, fetchImpl: stub.fetchImpl });
		/**
		 * The error handed to the refresh-error handler, captured for assertions.
		 * @type {unknown}
		 */
		let captured = null;
		provider.onRefreshError((error) => {
			captured = error;
		});

		mock.timers.tick(1000);
		await flushMicrotasks();
		await flushMicrotasks();

		assert.ok(captured instanceof TokenError);
		assert.match(captured.message, /500/);
		// The transient failure must NOT clobber the still-valid access token.
		assert.equal(provider.getAccessToken(), 'access-1');
		provider.stop();
	} finally {
		mock.timers.reset();
	}
});

runTestCase('a failed background refresh without a registered handler is swallowed silently', async () => {
	const stub = makeFetchStub([
		{ body: { access_token: 'access-1', refresh_token: 'offline-1', expires_in: 31 } },
		{ status: 503, body: 'down' }
	]);

	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		const provider = await login({ ...BASE_OPTIONS, fetchImpl: stub.fetchImpl });

		mock.timers.tick(1000);
		await flushMicrotasks();
		await flushMicrotasks();

		// No handler -> the rejection is swallowed; the stale token survives and nothing throws.
		assert.equal(provider.getAccessToken(), 'access-1');
		provider.stop();
	} finally {
		mock.timers.reset();
	}
});

runTestCase('a refresh response without a rotated refresh_token keeps reusing the previous one', async () => {
	const stub = makeFetchStub([
		{ body: { access_token: 'access-1', refresh_token: 'offline-1', expires_in: 31 } },
		// First refresh succeeds but Keycloak does NOT rotate the offline token.
		{ body: { access_token: 'access-2', expires_in: 31 } },
		{ body: { access_token: 'access-3', refresh_token: 'offline-3', expires_in: 31 } }
	]);

	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		const provider = await login({ ...BASE_OPTIONS, fetchImpl: stub.fetchImpl });

		mock.timers.tick(1000);
		await flushMicrotasks();
		assert.equal(provider.getAccessToken(), 'access-2');

		mock.timers.tick(1000);
		await flushMicrotasks();
		// The second refresh must still send the original offline-1 token (it was never rotated).
		assert.equal(stub.calls[2].params.get('refresh_token'), 'offline-1');
		assert.equal(provider.getAccessToken(), 'access-3');
		provider.stop();
	} finally {
		mock.timers.reset();
	}
});

runTestCase('an absent/zero expires_in falls back to the minimum refresh delay', async () => {
	const stub = makeFetchStub([
		// No expires_in -> the scheduler must clamp to MIN_REFRESH_DELAY_IN_S (1s), not spin a hot loop.
		{ body: { access_token: 'access-1', refresh_token: 'offline-1' } },
		{ body: { access_token: 'access-2', refresh_token: 'offline-2', expires_in: 31 } }
	]);

	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		const provider = await login({ ...BASE_OPTIONS, fetchImpl: stub.fetchImpl });
		assert.equal(provider.getAccessToken(), 'access-1');

		// The refresh must fire exactly at the 1s minimum delay.
		mock.timers.tick(1000);
		await flushMicrotasks();

		assert.equal(stub.calls.length, 2);
		assert.equal(provider.getAccessToken(), 'access-2');
		provider.stop();
	} finally {
		mock.timers.reset();
	}
});

runTestCase('a non-positive tokenExpirationInS lapses the loop immediately at schedule time', async () => {
	const stub = makeFetchStub([{ body: { access_token: 'access-1', refresh_token: 'offline-1', expires_in: 31 } }]);

	let fakeNowInMs = 5_000_000;
	/**
	 * Injectable clock returning the mutable `fakeNowInMs`, so `tokenExpirationInS=0` yields a deadline
	 * equal to "now" at bootstrap.
	 * @type {() => number}
	 */
	const nowInMs = () => fakeNowInMs;

	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		// tokenExpirationInS=0 -> deadline == now at bootstrap -> scheduleRefresh sees remaining <= 0 and stops.
		const provider = await login({
			...BASE_OPTIONS,
			fetchImpl: stub.fetchImpl,
			nowInMs,
			tokenExpirationInS: 0
		});
		assert.equal(provider.getAccessToken(), 'access-1');

		// No timer was armed; advancing the clock must not trigger a refresh.
		fakeNowInMs += 100_000;
		mock.timers.tick(100_000);
		await flushMicrotasks();

		assert.equal(stub.calls.length, 1);
		provider.stop();
	} finally {
		mock.timers.reset();
	}
});

runTestCase('login falls back to the global fetch when no fetchImpl is provided', async () => {
	/**
	 * URLs the overridden global fetch was called with, asserted against {@link EXPECTED_TOKEN_ENDPOINT}.
	 * @type {string[]}
	 */
	const calls = [];
	const originalFetch = globalThis.fetch;
	// Override the global fetch so the default-branch (`globalThis.fetch`) is exercised without network.
	globalThis.fetch = /** @type {typeof globalThis.fetch} */ (
		(url) => {
			calls.push(/** @type {string} */ (url));
			return Promise.resolve({
				ok: true,
				status: 200,
				text: () =>
					Promise.resolve(JSON.stringify({ access_token: 'global-1', refresh_token: 'offline-1', expires_in: 31 }))
			});
		}
	);

	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		const provider = await login({ ...BASE_OPTIONS });
		assert.equal(calls.length, 1);
		assert.equal(calls[0], EXPECTED_TOKEN_ENDPOINT);
		assert.equal(provider.getAccessToken(), 'global-1');
		provider.stop();
	} finally {
		globalThis.fetch = originalFetch;
		mock.timers.reset();
	}
});

runTestCase('the refresh timer arms on the real event loop and is unref-ed (does not block exit)', async () => {
	// No mocked timers here: this exercises the real setTimeout path so the Timeout.unref() call line runs.
	const stub = makeFetchStub([{ body: { access_token: 'access-1', refresh_token: 'offline-1', expires_in: 300 } }]);
	const provider = await login({ ...BASE_OPTIONS, fetchImpl: stub.fetchImpl });
	assert.equal(provider.getAccessToken(), 'access-1');
	// Stop immediately so the armed real timer is cleared and the test does not wait ~270s.
	provider.stop();
	// stop() is idempotent: a second call with the timer already cleared takes the `timer === null` branch.
	provider.stop();
});

runTestCase('stop() during an in-flight refresh suppresses re-arming the next refresh', async () => {
	/**
	 * Form-decoded bodies of each request the stub received, for counting login vs. refresh calls.
	 * @type {URLSearchParams[]}
	 */
	const calls = [];
	/**
	 * Captures the refresh resolver so the test can complete the in-flight refresh on demand (after
	 * calling stop()). Reassigned inside the pending-response promise below.
	 * @type {() => void}
	 */
	let releaseRefresh = () => {};
	/**
	 * Stub fetch that resolves the initial login immediately but parks the refresh response open until
	 * {@link releaseRefresh} is invoked, so the test can call stop() mid-refresh.
	 * @param {string} _url
	 *     The token endpoint (unused; the response is chosen by call order).
	 * @param {{ body?: string }} init
	 *     The `fetch` init whose `body` is recorded for assertions.
	 * @returns {Promise<{ ok: boolean, status: number, text: () => Promise<string> }>}
	 *     The login response on the first call, then a promise resolved only on release.
	 */
	const fetchImpl = (_url, init) => {
		calls.push(new URLSearchParams(init.body));
		if (calls.length === 1) {
			return Promise.resolve({
				ok: true,
				status: 200,
				text: () =>
					Promise.resolve(JSON.stringify({ access_token: 'access-1', refresh_token: 'offline-1', expires_in: 31 }))
			});
		}
		// Hold the refresh response open until the test releases it, after calling stop().
		return new Promise((resolve) => {
			releaseRefresh = () => {
				resolve({
					ok: true,
					status: 200,
					text: () =>
						Promise.resolve(JSON.stringify({ access_token: 'access-2', refresh_token: 'offline-2', expires_in: 31 }))
				});
			};
		});
	};

	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		const provider = await login({ ...BASE_OPTIONS, fetchImpl });

		// Fire the timer so refresh() starts and is parked awaiting the (pending) refresh response.
		mock.timers.tick(1000);
		await flushMicrotasks();
		assert.equal(calls.length, 2);

		// Stop while the refresh is in flight, then let it complete.
		provider.stop();
		releaseRefresh();
		await flushMicrotasks();
		await flushMicrotasks();

		// The completed refresh still updated the token, but scheduleRefresh saw `stopped` and armed nothing.
		assert.equal(provider.getAccessToken(), 'access-2');
		mock.timers.tick(100_000);
		await flushMicrotasks();
		assert.equal(calls.length, 2);
	} finally {
		mock.timers.reset();
	}
});

runTestCase('refresh() returns early when the provider is already stopped', async () => {
	const stub = makeFetchStub([{ body: { access_token: 'access-1', refresh_token: 'offline-1', expires_in: 31 } }]);
	const provider = await login({ ...BASE_OPTIONS, fetchImpl: stub.fetchImpl });
	provider.stop();
	// Directly invoking refresh() after stop() hits the `stopped` guard and performs no fetch.
	await provider.refresh();
	assert.equal(stub.calls.length, 1);
});

/**
 * Asserts the SECURE default (keycloakVerifySsl omitted): the token POST carries NO insecure undici
 * dispatcher, so the default global fetch performs TLS certificate verification -- unchanged behaviour.
 */
runTestCase('keycloakVerifySsl defaults to TLS verification ON (no insecure dispatcher on the request)', async () => {
	const stub = makeFetchStub([{ body: { access_token: 'access-1', refresh_token: 'offline-1', expires_in: 300 } }]);
	const provider = await login({ ...BASE_OPTIONS, fetchImpl: stub.fetchImpl });
	assert.equal(stub.calls[0].init.dispatcher, undefined);
	provider.stop();
});

/**
 * Asserts that an EXPLICIT `keycloakVerifySsl: true` behaves exactly like the default: no insecure
 * dispatcher is attached (TLS verification stays ON).
 */
runTestCase('keycloakVerifySsl=true keeps TLS verification ON (no insecure dispatcher on the request)', async () => {
	const stub = makeFetchStub([{ body: { access_token: 'access-1', refresh_token: 'offline-1', expires_in: 300 } }]);
	const provider = await login({ ...BASE_OPTIONS, fetchImpl: stub.fetchImpl, keycloakVerifySsl: true });
	assert.equal(stub.calls[0].init.dispatcher, undefined);
	provider.stop();
});

/**
 * Asserts that `keycloakVerifySsl: false` wires an insecure undici `Agent` dispatcher (rejectUnauthorized
 * off) onto the token POST init, disabling TLS certificate verification for that request only.
 */
runTestCase('keycloakVerifySsl=false attaches an insecure undici dispatcher to the token request', async () => {
	const stub = makeFetchStub([{ body: { access_token: 'access-1', refresh_token: 'offline-1', expires_in: 300 } }]);
	const provider = await login({ ...BASE_OPTIONS, fetchImpl: stub.fetchImpl, keycloakVerifySsl: false });
	assert.notEqual(stub.calls[0].init.dispatcher, undefined);
	assert.ok(stub.calls[0].init.dispatcher instanceof Agent);
	provider.stop();
});

/**
 * Asserts that the verify-off flag also applies to the background refresh: the re-armed refresh POST
 * carries the same insecure undici dispatcher as the initial login POST.
 */
runTestCase('keycloakVerifySsl=false also disables TLS verification on the background refresh', async () => {
	const stub = makeFetchStub([
		{ body: { access_token: 'access-1', refresh_token: 'offline-1', expires_in: 31 } },
		{ body: { access_token: 'access-2', refresh_token: 'offline-2', expires_in: 31 } }
	]);

	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		const provider = await login({ ...BASE_OPTIONS, fetchImpl: stub.fetchImpl, keycloakVerifySsl: false });

		mock.timers.tick(1000);
		await flushMicrotasks();

		assert.equal(stub.calls.length, 2);
		assert.ok(stub.calls[1].init.dispatcher instanceof Agent);
		provider.stop();
	} finally {
		mock.timers.reset();
	}
});

/**
 * Asserts Python-parity "flag ignored when a custom transport is injected": even with
 * `keycloakVerifySsl: false`, the injected `fetchImpl` still receives the call and yields a token. The
 * dispatcher lands on the init (a no-op for the fake fetch, which does not honour it), and login succeeds.
 */
runTestCase('keycloakVerifySsl=false still logs in through an injected fetchImpl (flag is a no-op there)', async () => {
	const stub = makeFetchStub([{ body: { access_token: 'access-1', refresh_token: 'offline-1', expires_in: 300 } }]);
	const provider = await login({ ...BASE_OPTIONS, fetchImpl: stub.fetchImpl, keycloakVerifySsl: false });
	assert.equal(stub.calls.length, 1);
	assert.equal(provider.getAccessToken(), 'access-1');
	provider.stop();
});
