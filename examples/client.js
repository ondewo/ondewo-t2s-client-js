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

// Minimal, idiomatic example for the ONDEWO Text-to-Speech (T2S) grpc-web client.
//
// It shows the representative use-case: authenticate with a Keycloak bearer token, build a
// SynthesizeRequest for a pipeline, call Text2Speech.Synthesize, and read the generated audio off
// the response. The RPC helpers take the grpc-web `ondewo_t2s_api` namespace, a constructed client
// and an auth token-provider as arguments (dependency injection) so they can be unit-tested with the
// gRPC layer mocked and no live server -- see `client.spec.js`. `main()` wires the real browser
// globals together for reference.

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, 'environment.env') });

const { login } = require('../auth/offlineTokenProvider');

/**
 * Read a required environment variable, throwing a descriptive error when it is missing or empty so a
 * misconfigured `examples/environment.env` fails fast with actionable context instead of a cryptic RPC
 * error later on.
 *
 * @param {string} name
 *     The canonical environment variable name (see `examples/environment.env`).
 * @returns {string}
 *     The trimmed value of the variable.
 */
function requireEnv(name) {
	const value = process.env[name];
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new Error(`Missing required environment variable "${name}" (set it in examples/environment.env)`);
	}
	return value.trim();
}

/**
 * Build the gRPC-web endpoint URL from the canonical connection env vars.
 *
 * @returns {string}
 *     The `http(s)://host:port` endpoint the Text2Speech client connects to.
 */
function buildEndpoint() {
	const host = requireEnv('ONDEWO_HOST');
	const port = requireEnv('ONDEWO_PORT');
	const scheme = process.env.ONDEWO_USE_SECURE_CHANNEL === 'false' ? 'http' : 'https';
	return `${scheme}://${host}:${port}`;
}

/**
 * The grpc-web message/client namespace registered by `api/ondewo_t2s_api.js`. Only the members this
 * example constructs are described; the generated bundle exposes the full T2S surface.
 *
 * @typedef {object} T2sApi
 * @property {new () => SynthesizeRequest} SynthesizeRequest
 *     Constructor for the Synthesize request message.
 * @property {new () => RequestConfig} RequestConfig
 *     Constructor for the per-request configuration message.
 * @property {new (hostname: string, credentials?: unknown, options?: unknown) => Text2SpeechClient} Text2SpeechPromiseClient
 *     Constructor for the promise-based Text2Speech service client.
 */

/**
 * The per-request configuration message; carries the target pipeline id (and, optionally, tuning
 * fields not used in this minimal example).
 *
 * @typedef {object} RequestConfig
 * @property {(pipelineId: string) => void} setT2sPipelineId
 *     Set the id of the T2S pipeline that should synthesize the text.
 */

/**
 * The Synthesize request message.
 *
 * @typedef {object} SynthesizeRequest
 * @property {(text: string) => void} setText
 *     Set the text to synthesize.
 * @property {(config: RequestConfig) => void} setConfig
 *     Attach the {@link RequestConfig}.
 */

/**
 * The Synthesize response message; only the getters this example reads are described.
 *
 * @typedef {object} SynthesizeResponse
 * @property {() => string} getAudioUuid
 *     The uuid identifying the generated audio.
 * @property {() => Uint8Array} getAudio_asU8
 *     The generated audio as raw bytes.
 * @property {() => number} getAudioLength
 *     The length of the generated audio in seconds.
 * @property {() => number} getGenerationTime
 *     The time it took the server to generate the audio, in seconds.
 * @property {() => string} getText
 *     The text the audio was generated from.
 */

/**
 * The promise-based Text2Speech service client; only the RPC this example calls is described.
 *
 * @typedef {object} Text2SpeechClient
 * @property {(request: SynthesizeRequest, metadata: Record<string, string>) => Promise<SynthesizeResponse>} synthesize
 *     Synthesize the request's text and resolve with the generated audio.
 */

/**
 * A holder for a live Keycloak bearer token, as returned by `login()` in `auth/offlineTokenProvider`.
 *
 * @typedef {object} TokenProvider
 * @property {() => string} getAuthorizationHeader
 *     The `Authorization` header value for an authenticated gRPC call, e.g. `Bearer <access-token>`.
 */

/**
 * The inputs for a single synthesis.
 *
 * @typedef {object} SynthesizeOptions
 * @property {string} text
 *     The text to convert to speech.
 * @property {string} pipelineId
 *     The id of the T2S pipeline to synthesize with (see `ListT2sPipelines`).
 */

/**
 * A plain, framework-agnostic summary of a {@link SynthesizeResponse}.
 *
 * @typedef {object} SynthesizeResult
 * @property {string} audioUuid
 *     The uuid identifying the generated audio.
 * @property {Uint8Array} audioBytes
 *     The generated audio as raw bytes, ready to be wrapped in a Blob / written to a file.
 * @property {number} audioLength
 *     The length of the generated audio in seconds.
 * @property {number} generationTime
 *     The server-side generation time in seconds.
 * @property {string} text
 *     The text the audio was generated from.
 */

/**
 * Build a {@link SynthesizeRequest} for a single utterance and the target pipeline.
 *
 * @param {T2sApi} t2sApi
 *     The grpc-web message namespace used to construct the messages.
 * @param {SynthesizeOptions} options
 *     The text to synthesize and the pipeline to use.
 * @returns {SynthesizeRequest}
 *     The populated request, ready to hand to {@link Text2SpeechClient#synthesize}.
 */
function buildSynthesizeRequest(t2sApi, options) {
	const request = new t2sApi.SynthesizeRequest();
	request.setText(options.text);
	const config = new t2sApi.RequestConfig();
	config.setT2sPipelineId(options.pipelineId);
	request.setConfig(config);
	return request;
}

/**
 * Build the gRPC metadata carrying the Keycloak bearer token for an authenticated call.
 *
 * @param {TokenProvider} tokenProvider
 *     The live token provider whose `Authorization` header is forwarded to the server.
 * @returns {Record<string, string>}
 *     grpc-web metadata with a single `Authorization: Bearer <access-token>` entry.
 */
function bearerMetadata(tokenProvider) {
	return { Authorization: tokenProvider.getAuthorizationHeader() };
}

/**
 * Synthesize `options.text` on `options.pipelineId` and return a plain summary of the generated audio.
 *
 * @param {T2sApi} t2sApi
 *     The grpc-web message namespace used to construct the request.
 * @param {Text2SpeechClient} client
 *     The (already constructed) Text2Speech promise client.
 * @param {TokenProvider} tokenProvider
 *     The bearer-token provider used to authenticate the call.
 * @param {SynthesizeOptions} options
 *     The text to synthesize and the pipeline to use.
 * @returns {Promise<SynthesizeResult>}
 *     A framework-agnostic summary of the synthesized audio.
 */
async function synthesizeText(t2sApi, client, tokenProvider, options) {
	const request = buildSynthesizeRequest(t2sApi, options);
	const response = await client.synthesize(request, bearerMetadata(tokenProvider));
	return {
		audioUuid: response.getAudioUuid(),
		audioBytes: response.getAudio_asU8(),
		audioLength: response.getAudioLength(),
		generationTime: response.getGenerationTime(),
		text: response.getText()
	};
}

/**
 * Reference wiring: authenticate, construct the client and synthesize one utterance.
 *
 * In a browser, load `api/ondewo_t2s_api.js` via a `<script>` tag first (see `index.html`); it
 * registers the `ondewo_t2s_api` global read here. All connection / Keycloak / pipeline values are
 * read from `examples/environment.env` (see the canonical variable names there). Not executed by the
 * test suite -- it reaches a live server.
 *
 * @returns {Promise<void>}
 *     Resolves once the utterance has been synthesized and the token provider stopped.
 */
async function main() {
	const endpoint = buildEndpoint();
	console.log(`START: synthesizing on T2S endpoint ${endpoint}`);

	/** @type {T2sApi} */
	const t2sApi = /** @type {any} */ (globalThis).ondewo_t2s_api;
	const client = new t2sApi.Text2SpeechPromiseClient(endpoint);

	console.log(
		`Authenticating with Keycloak at ${requireEnv('KEYCLOAK_URL')} (realm "${requireEnv('KEYCLOAK_REALM')}")`
	);
	const tokenProvider = await login({
		keycloakUrl: requireEnv('KEYCLOAK_URL'),
		realm: requireEnv('KEYCLOAK_REALM'),
		clientId: requireEnv('KEYCLOAK_CLIENT_ID'),
		username: requireEnv('KEYCLOAK_USER_NAME'),
		password: requireEnv('KEYCLOAK_PASSWORD'),
		keycloakVerifySsl: process.env.KEYCLOAK_VERIFY_SSL !== 'false'
	});
	try {
		const pipelineId = requireEnv('ONDEWO_T2S_PIPELINE_ID');
		const text = requireEnv('ONDEWO_T2S_TEXT');
		console.log(`Requesting Synthesize on pipeline "${pipelineId}"`);
		const result = await synthesizeText(t2sApi, client, tokenProvider, { text, pipelineId });
		console.log(
			`DONE: synthesized audio ${result.audioUuid} (${result.audioLength}s, ${result.audioBytes.length} bytes)`
		);
	} finally {
		tokenProvider.stop();
	}
}

module.exports = { buildSynthesizeRequest, bearerMetadata, synthesizeText, buildEndpoint, requireEnv, main };

// Reference entrypoint: run `node examples/client.js` against a live T2S deployment configured via
// `examples/environment.env`. Not reached by the unit tests (which import the helpers above).
if (require.main === module) {
	main().catch((error) => {
		console.error('FAILED: T2S synthesize example errored:', error);
		process.exit(1);
	});
}
