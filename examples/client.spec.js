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

const { buildSynthesizeRequest, bearerMetadata, synthesizeText } = require('./client');

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
