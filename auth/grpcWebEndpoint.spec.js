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

// Unit tests for the gRPC-web endpoint builder (the TLS contract as far as a browser SDK controls it:
// scheme, host/port, refusing PEMs and keys, the insecure warning).
//   node --test auth/grpcWebEndpoint.spec.js

'use strict';

/* global require, __dirname */

const { test: runTestCase, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { buildGrpcWebEndpoint } = require('./grpcWebEndpoint');

/**
 * A recognisable stand-in for PEM content. Assembled at runtime so the repo's `detect-private-key`
 * hook never sees a key header in the source; no real key exists anywhere in this repo.
 *
 * @type {string}
 */
const FAKE_KEY_PEM = ['-----BEGIN ', 'PRIVATE KEY-----\nMARKER-KEY-CONTENT\n-----END ', 'PRIVATE KEY-----\n'].join('');

/**
 * A recognisable stand-in for a certificate PEM.
 *
 * @type {string}
 */
const FAKE_CERT_PEM = '-----BEGIN CERTIFICATE-----\r\nMARKER-CERT-CONTENT\r\n-----END CERTIFICATE-----\r\n';

/**
 * Run `action` with `console.warn` replaced by a recorder.
 *
 * @template T
 * @param {() => T} action
 *   The code under test.
 * @returns {{ result: T, warnings: string[] }}
 *   The action's result and every warning it logged.
 */
function captureWarnings(action) {
	/** @type {string[]} */
	const warnings = [];
	const warnMock = mock.method(console, 'warn', (/** @type {string} */ message) => {
		warnings.push(message);
	});
	try {
		return { result: action(), warnings };
	} finally {
		warnMock.mock.restore();
	}
}

/**
 * Assert that `action` throws an error of `errorType` whose message names `fragment` and renders no PEM.
 *
 * @param {() => unknown} action
 *   The call expected to throw.
 * @param {Function} errorType
 *   The expected error class.
 * @param {string} fragment
 *   A substring the message must contain (normally the option name).
 * @returns {void}
 */
function assertRejects(action, errorType, fragment) {
	assert.throws(action, (/** @type {Error} */ error) => {
		assert.ok(error instanceof errorType, `expected ${errorType.name}, got ${error.name}`);
		assert.ok(error.message.includes(fragment), `"${error.message}" does not mention ${fragment}`);
		assert.ok(!error.message.includes('MARKER'), 'the error message renders PEM content');
		assert.ok(!error.message.includes('BEGIN'), 'the error message renders PEM content');
		return true;
	});
}

runTestCase('secure is the default: https with host and port, no warning', () => {
	const { result, warnings } = captureWarnings(() => buildGrpcWebEndpoint({ host: 'nlu.example.com', port: 443 }));
	assert.equal(result, 'https://nlu.example.com:443');
	assert.deepEqual(warnings, []);
});

runTestCase('useSecureChannel: true gives https; a numeric-string port is accepted', () => {
	assert.equal(
		buildGrpcWebEndpoint({ host: 'localhost', port: '8443', useSecureChannel: true }),
		'https://localhost:8443'
	);
});

runTestCase('without a port the scheme default port is used', () => {
	assert.equal(buildGrpcWebEndpoint({ host: 'nlu.example.com' }), 'https://nlu.example.com');
	assert.equal(
		buildGrpcWebEndpoint(/** @type {any} */ ({ host: 'nlu.example.com', port: null })),
		'https://nlu.example.com'
	);
	assert.equal(buildGrpcWebEndpoint({ host: 'nlu.example.com', port: '' }), 'https://nlu.example.com');
});

runTestCase('insecure gives plaintext http and warns naming host:port', () => {
	const { result, warnings } = captureWarnings(() =>
		buildGrpcWebEndpoint({ host: '10.0.0.5', port: 8080, useSecureChannel: false })
	);
	assert.equal(result, 'http://10.0.0.5:8080');
	assert.equal(warnings.length, 1);
	assert.ok(warnings[0].includes('10.0.0.5:8080'), warnings[0]);
	assert.ok(warnings[0].includes('insecure'), warnings[0]);
});

runTestCase('bare IPv6 literals are bracketed, bracketed ones are kept as given', () => {
	assert.equal(buildGrpcWebEndpoint({ host: '::1', port: 50051 }), 'https://[::1]:50051');
	assert.equal(buildGrpcWebEndpoint({ host: '[::1]', port: 50051 }), 'https://[::1]:50051');
	assert.equal(buildGrpcWebEndpoint({ host: 'fd00::5' }), 'https://[fd00::5]');
	assert.equal(buildGrpcWebEndpoint({ host: '::ffff:127.0.0.1', port: 1 }), 'https://[::ffff:127.0.0.1]:1');
	const { warnings } = captureWarnings(() => buildGrpcWebEndpoint({ host: '::1', port: 80, useSecureChannel: false }));
	assert.ok(warnings[0].includes('[::1]:80'), warnings[0]);
});

runTestCase('a host carrying a port or a scheme is rejected', () => {
	assertRejects(() => buildGrpcWebEndpoint({ host: 'localhost:8443' }), TypeError, '"port"');
	assertRejects(() => buildGrpcWebEndpoint({ host: 'https://localhost' }), TypeError, '"host"');
	assertRejects(() => buildGrpcWebEndpoint({ host: 'localhost/path' }), TypeError, '"host"');
});

runTestCase('a missing or empty host, or no options at all, is rejected', () => {
	assertRejects(() => buildGrpcWebEndpoint(/** @type {any} */ (undefined)), TypeError, 'options object');
	assertRejects(() => buildGrpcWebEndpoint(/** @type {any} */ (null)), TypeError, 'options object');
	assertRejects(() => buildGrpcWebEndpoint(/** @type {any} */ ({})), TypeError, '"host"');
	assertRejects(() => buildGrpcWebEndpoint({ host: '' }), TypeError, '"host"');
	assertRejects(() => buildGrpcWebEndpoint(/** @type {any} */ ({ host: 42 })), TypeError, '"host"');
});

runTestCase('an out-of-range or non-integer port is rejected', () => {
	for (const port of [0, 65536, 1.5, -1, '84a', '1e3', ' 80', true]) {
		assertRejects(() => buildGrpcWebEndpoint(/** @type {any} */ ({ host: 'localhost', port })), TypeError, '"port"');
	}
	assert.equal(buildGrpcWebEndpoint({ host: 'localhost', port: 65535 }), 'https://localhost:65535');
});

runTestCase('a non-boolean useSecureChannel is rejected (the string "false" is not false)', () => {
	for (const useSecureChannel of ['false', 'true', 0, 1]) {
		assertRejects(
			() => buildGrpcWebEndpoint(/** @type {any} */ ({ host: 'localhost', useSecureChannel })),
			TypeError,
			'"useSecureChannel"'
		);
	}
});

runTestCase('a client private key is refused, also without a certificate (half pair)', () => {
	assertRejects(
		() => buildGrpcWebEndpoint({ host: 'localhost', grpcClientKey: FAKE_KEY_PEM }),
		Error,
		'"grpcClientKey"'
	);
});

runTestCase('a client certificate is refused, also without a key (half pair)', () => {
	assertRejects(
		() => buildGrpcWebEndpoint({ host: 'localhost', grpcClientCert: FAKE_CERT_PEM }),
		Error,
		'"grpcClientCert"'
	);
});

runTestCase('a full client identity is refused; the key is named first', () => {
	assertRejects(
		() => buildGrpcWebEndpoint({ host: 'localhost', grpcClientCert: FAKE_CERT_PEM, grpcClientKey: FAKE_KEY_PEM }),
		Error,
		'"grpcClientKey"'
	);
});

runTestCase('insecure plus a client identity is an error, never a silently dropped identity', () => {
	const { warnings } = captureWarnings(() =>
		assertRejects(
			() =>
				buildGrpcWebEndpoint({
					host: 'localhost',
					useSecureChannel: false,
					grpcClientCert: FAKE_CERT_PEM,
					grpcClientKey: FAKE_KEY_PEM
				}),
			Error,
			'"grpcClientKey"'
		)
	);
	assert.deepEqual(warnings, [], 'nothing is logged before the refusal');
});

runTestCase('a custom CA PEM is refused: the browser trust store decides', () => {
	assertRejects(() => buildGrpcWebEndpoint({ host: 'localhost', grpcCert: FAKE_CERT_PEM }), Error, '"grpcCert"');
});

runTestCase('empty strings (or null) on all PEM fields mean plain TLS', () => {
	const { result, warnings } = captureWarnings(() =>
		buildGrpcWebEndpoint({ host: 'localhost', port: 8443, grpcCert: '', grpcClientCert: '', grpcClientKey: '' })
	);
	assert.equal(result, 'https://localhost:8443');
	assert.deepEqual(warnings, []);
	assert.equal(
		buildGrpcWebEndpoint(
			/** @type {any} */ ({ host: 'localhost', grpcCert: null, grpcClientCert: null, grpcClientKey: null })
		),
		'https://localhost'
	);
});

runTestCase('the generated gRPC-web client takes the built endpoint as its hostname', () => {
	const source = fs.readFileSync(path.join(__dirname, '..', 'api', 'ondewo_t2s_api.js'), 'utf8');
	/** @type {any} */
	const context = { window: {}, self: {} };
	context.globalThis = context;
	vm.createContext(context);
	vm.runInContext(source, context);
	const endpoint = buildGrpcWebEndpoint({ host: '::1', port: 8443 });
	const client = new context.ondewo_t2s_api.Text2SpeechPromiseClient(endpoint, null, null);
	assert.equal(client.hostname_, 'https://[::1]:8443');
});
