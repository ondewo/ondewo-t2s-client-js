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

// Unit tests for the T2S synthesize example. The grpc-web message classes and the Text2Speech client
// are mocked -- there is NO live server and no real `api/ondewo_t2s_api.js` bundle. The tests assert
// that the example builds the right request, attaches the bearer metadata, and maps the response.
//   node --test examples/client.spec.js

'use strict';

const { test: runTestCase } = require('node:test');
const assert = require('node:assert/strict');

const { buildSynthesizeRequest, bearerMetadata, synthesizeText, buildEndpoint, requireEnv, main } = require('./client');

/**
 * A single request captured by the fake client, for post-hoc assertions on what was sent.
 *
 * @typedef {object} CapturedCall
 * @property {FakeSynthesizeRequest} request
 *     The request message the example built and handed to the client.
 * @property {Record<string, string>} metadata
 *     The gRPC metadata the example attached to the call.
 */

/**
 * A stand-in for the generated `RequestConfig` message that records its setter calls instead of
 * serializing to protobuf.
 */
class FakeRequestConfig {
	constructor() {
		/** @type {string} */
		this.pipelineId = '';
	}
	/** @param {string} pipelineId */
	setT2sPipelineId(pipelineId) {
		this.pipelineId = pipelineId;
	}
	getT2sPipelineId() {
		return this.pipelineId;
	}
}

/**
 * A stand-in for the generated `SynthesizeRequest` message that records its setter calls.
 */
class FakeSynthesizeRequest {
	constructor() {
		/** @type {string} */
		this.text = '';
		/** @type {FakeRequestConfig} */
		this.config = new FakeRequestConfig();
	}
	/** @param {string} text */
	setText(text) {
		this.text = text;
	}
	getText() {
		return this.text;
	}
	/** @param {FakeRequestConfig} config */
	setConfig(config) {
		this.config = config;
	}
	getConfig() {
		return this.config;
	}
}

/**
 * Build a fake `ondewo_t2s_api` namespace exposing only the message constructors the example uses.
 *
 * @returns {{ SynthesizeRequest: new () => FakeSynthesizeRequest, RequestConfig: new () => FakeRequestConfig }}
 *     The minimal grpc-web namespace stand-in.
 */
function makeFakeApi() {
	return { SynthesizeRequest: FakeSynthesizeRequest, RequestConfig: FakeRequestConfig };
}

/**
 * Build a fake Text2Speech promise client whose `synthesize` records the call and resolves with a
 * scripted response, so no network / real bundle is touched.
 *
 * @param {object} response
 *     The response object (with grpc-web-style getters) to resolve `synthesize` with.
 * @param {CapturedCall} capture
 *     A live object the fake writes the received `request` and `metadata` into.
 * @returns {{ synthesize: (request: FakeSynthesizeRequest, metadata: Record<string, string>) => Promise<object> }}
 *     The client stand-in.
 */
function makeFakeClient(response, capture) {
	return {
		synthesize(request, metadata) {
			capture.request = request;
			capture.metadata = metadata;
			return Promise.resolve(response);
		}
	};
}

/**
 * Build a fake `SynthesizeResponse` exposing the grpc-web getters the example reads.
 *
 * @param {{ audioUuid: string, audioBytes: Uint8Array, audioLength: number, generationTime: number, text: string }} fields
 *     The values the getters should return.
 * @returns {object}
 *     The response stand-in.
 */
function makeFakeResponse(fields) {
	return {
		getAudioUuid: () => fields.audioUuid,
		getAudio_asU8: () => fields.audioBytes,
		getAudioLength: () => fields.audioLength,
		getGenerationTime: () => fields.generationTime,
		getText: () => fields.text
	};
}

runTestCase('buildSynthesizeRequest sets the text and nests the pipeline id inside the RequestConfig', () => {
	const spokenText = 'Guten Tag';
	const pipelineId = 'de-DE-pipeline';

	const request = /** @type {FakeSynthesizeRequest} */ (
		/** @type {unknown} */ (
			buildSynthesizeRequest(/** @type {any} */ (makeFakeApi()), { text: spokenText, pipelineId })
		)
	);

	assert.equal(request.getText(), spokenText);
	assert.equal(request.getConfig().getT2sPipelineId(), pipelineId);
});

runTestCase('bearerMetadata forwards the provider Authorization header as grpc-web metadata', () => {
	const authHeader = 'Bearer access-token-xyz';

	const metadata = bearerMetadata({ getAuthorizationHeader: () => authHeader });

	assert.deepEqual(metadata, { Authorization: authHeader });
});

runTestCase('synthesizeText builds the request, attaches bearer metadata, and maps the response', async () => {
	const spokenText = 'Hello from ONDEWO';
	const pipelineId = 'en-US-pipeline';
	const authHeader = 'Bearer access-1';
	const audioBytes = new Uint8Array([1, 2, 3, 4]);

	/** @type {CapturedCall} */
	const capture = { request: new FakeSynthesizeRequest(), metadata: {} };
	const response = makeFakeResponse({
		audioUuid: 'audio-uuid-1',
		audioBytes,
		audioLength: 1.25,
		generationTime: 0.2,
		text: spokenText
	});
	const client = makeFakeClient(response, capture);
	const tokenProvider = { getAuthorizationHeader: () => authHeader };

	const result = await synthesizeText(/** @type {any} */ (makeFakeApi()), /** @type {any} */ (client), tokenProvider, {
		text: spokenText,
		pipelineId
	});

	// The example built the request the server expects ...
	assert.equal(capture.request.getText(), spokenText);
	assert.equal(capture.request.getConfig().getT2sPipelineId(), pipelineId);
	// ... authenticated the call with the bearer token ...
	assert.deepEqual(capture.metadata, { Authorization: authHeader });
	// ... and mapped every response field into the plain summary.
	assert.equal(result.audioUuid, 'audio-uuid-1');
	assert.deepEqual(result.audioBytes, audioBytes);
	assert.equal(result.audioLength, 1.25);
	assert.equal(result.generationTime, 0.2);
	assert.equal(result.text, spokenText);
});

/**
 * A stand-in for the generated `Text2SpeechPromiseClient` that records the endpoint it was constructed
 * with and resolves `synthesize` with a scripted response, so {@link main} touches no network.
 */
class FakeText2SpeechPromiseClient {
	/**
	 * @param {string} hostname
	 *     The gRPC-web endpoint the example built from the connection env vars.
	 */
	constructor(hostname) {
		/** @type {string} */
		this.hostname = hostname;
	}
	/**
	 * @param {FakeSynthesizeRequest} request
	 *     The request message the example built.
	 * @param {Record<string, string>} metadata
	 *     The gRPC metadata the example attached.
	 * @returns {Promise<object>}
	 *     A fixed {@link makeFakeResponse} payload.
	 */
	synthesize(request, metadata) {
		FakeText2SpeechPromiseClient.lastCall = { request, metadata, hostname: this.hostname };
		return Promise.resolve(
			makeFakeResponse({
				audioUuid: 'audio-uuid-main',
				audioBytes: new Uint8Array([7, 7]),
				audioLength: 0.5,
				generationTime: 0.1,
				text: 'Hallo Welt'
			})
		);
	}
}

/**
 * Run `body` with `process.env` overridden by `overrides` (a `null` value deletes the variable) and the
 * console silenced, restoring both afterwards. `main()` and `buildEndpoint()` read `process.env` at call
 * time, so the whole environment-dependent surface can be driven without touching the real one.
 *
 * @param {Record<string, string | null>} overrides
 *     The variables to set (string) or delete (null) for the duration of `body`.
 * @param {() => Promise<void> | void} body
 *     The code to run under the patched environment.
 * @returns {Promise<void>}
 *     Resolves once `body` has settled and the environment has been restored.
 */
async function withEnv(overrides, body) {
	/** @type {Record<string, string | undefined>} */
	const saved = {};
	for (const key of Object.keys(overrides)) {
		saved[key] = process.env[key];
		const value = overrides[key];
		if (value === null) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	const originalLog = console.log;
	console.log = () => {};
	try {
		await body();
	} finally {
		console.log = originalLog;
		for (const key of Object.keys(saved)) {
			const value = saved[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}
}

runTestCase('requireEnv returns the trimmed value of a populated variable', async () => {
	await withEnv({ ONDEWO_T2S_SPEC_PROBE: '  spaced-value  ' }, () => {
		assert.equal(requireEnv('ONDEWO_T2S_SPEC_PROBE'), 'spaced-value');
	});
});

runTestCase('requireEnv throws with actionable context when a variable is missing or blank', async () => {
	// Both operands of the guard: absent (not a string) and present-but-whitespace-only.
	await withEnv({ ONDEWO_T2S_SPEC_PROBE: null }, () => {
		assert.throws(() => requireEnv('ONDEWO_T2S_SPEC_PROBE'), /examples\/environment\.env/);
	});
	await withEnv({ ONDEWO_T2S_SPEC_PROBE: '   ' }, () => {
		assert.throws(() => requireEnv('ONDEWO_T2S_SPEC_PROBE'), /ONDEWO_T2S_SPEC_PROBE/);
	});
});

runTestCase('buildEndpoint uses https by default and http only when the secure channel is off', async () => {
	await withEnv({ ONDEWO_HOST: 't2s.example.com', ONDEWO_PORT: '443', ONDEWO_USE_SECURE_CHANNEL: 'true' }, () => {
		assert.equal(buildEndpoint(), 'https://t2s.example.com:443');
	});
	await withEnv({ ONDEWO_HOST: 't2s.example.com', ONDEWO_PORT: '8080', ONDEWO_USE_SECURE_CHANNEL: 'false' }, () => {
		assert.equal(buildEndpoint(), 'http://t2s.example.com:8080');
	});
});

runTestCase('main wires login, client construction and Synthesize together end to end', async () => {
	/**
	 * The token-endpoint URLs the stubbed global fetch was called with.
	 * @type {string[]}
	 */
	const tokenCalls = [];
	const originalFetch = globalThis.fetch;
	const originalApi = /** @type {any} */ (globalThis).ondewo_t2s_api;
	// The example reads the grpc-web bundle off the browser global; substitute the fakes above.
	/** @type {any} */ (globalThis).ondewo_t2s_api = {
		SynthesizeRequest: FakeSynthesizeRequest,
		RequestConfig: FakeRequestConfig,
		Text2SpeechPromiseClient: FakeText2SpeechPromiseClient
	};
	// login() falls back to globalThis.fetch; stub it so the Keycloak ROPC call is hermetic.
	globalThis.fetch = /** @type {typeof globalThis.fetch} */ (
		(url) => {
			tokenCalls.push(/** @type {string} */ (url));
			return Promise.resolve({
				ok: true,
				status: 200,
				text: () =>
					Promise.resolve(
						JSON.stringify({ access_token: 'access-main', refresh_token: 'offline-main', expires_in: 300 })
					)
			});
		}
	);

	try {
		await withEnv(
			{
				ONDEWO_HOST: 't2s.example.com',
				ONDEWO_PORT: '443',
				ONDEWO_USE_SECURE_CHANNEL: 'true',
				KEYCLOAK_URL: 'https://auth.example.com/auth',
				KEYCLOAK_REALM: 'ondewo-ccai-platform',
				KEYCLOAK_CLIENT_ID: 'ondewo-nlu-cai-sdk-public',
				KEYCLOAK_USER_NAME: 'tech-user@example.com',
				KEYCLOAK_PASSWORD: 'super-secret',
				KEYCLOAK_VERIFY_SSL: 'true',
				ONDEWO_T2S_PIPELINE_ID: 'de-DE-pipeline',
				ONDEWO_T2S_TEXT: 'Hallo Welt'
			},
			() => main()
		);
	} finally {
		globalThis.fetch = originalFetch;
		/** @type {any} */ (globalThis).ondewo_t2s_api = originalApi;
	}

	assert.deepEqual(tokenCalls, [
		'https://auth.example.com/auth/realms/ondewo-ccai-platform/protocol/openid-connect/token'
	]);
	const lastCall = FakeText2SpeechPromiseClient.lastCall;
	// The client was bound to the endpoint built from the connection env vars ...
	assert.equal(lastCall.hostname, 'https://t2s.example.com:443');
	// ... the request carried the configured text + pipeline ...
	assert.equal(lastCall.request.getText(), 'Hallo Welt');
	assert.equal(lastCall.request.getConfig().getT2sPipelineId(), 'de-DE-pipeline');
	// ... and the call was authenticated with the token the stubbed Keycloak returned.
	assert.deepEqual(lastCall.metadata, { Authorization: 'Bearer access-main' });
});
