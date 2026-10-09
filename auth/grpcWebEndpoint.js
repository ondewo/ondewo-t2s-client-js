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

// Builds the gRPC-web endpoint URL handed to every generated `*PromiseClient` / `*Client` constructor,
// following the ONDEWO SDK TLS contract as far as a browser allows (README "TLS, mutual TLS and
// certificates"):
//
// - `useSecureChannel` (default `true`) selects `https://`; `false` selects plaintext `http://` and
//   logs a warning naming `host:port`.
// - TLS is the browser's: the server certificate is verified against the browser / OS trust store,
//   and a client certificate for mutual TLS can only come from the browser's own certificate store.
//   JavaScript cannot set either, so `grpcCert`, `grpcClientCert` and `grpcClientKey` are REFUSED
//   (never silently dropped) -- and a private key must never be shipped to a browser in the first place.
// - Bare IPv6 literals are bracketed (`[::1]`).
// - No message ever contains a PEM or a key.

'use strict';

/* global module */

/**
 * The options accepted by {@link buildGrpcWebEndpoint}. The three PEM fields exist only so that a
 * config shared with the other ONDEWO SDKs is refused loudly instead of being silently ignored.
 *
 * @typedef {object} GrpcWebEndpointOptions
 * @property {string} host
 *   The bare host name or IP address of the gRPC-web front (Envoy), without scheme and without port.
 * @property {number | string} [port]
 *   The port; omit it to use the scheme's default (443 for https, 80 for http).
 * @property {boolean} [useSecureChannel]
 *   `true` (default) for https, `false` for plaintext http (not for production).
 * @property {string} [grpcCert]
 *   Refused when non-empty: the browser trusts its own certificate store, not a PEM from JavaScript.
 * @property {string} [grpcClientCert]
 *   Refused when non-empty: a browser presents a client certificate only from its own certificate store.
 * @property {string} [grpcClientKey]
 *   Refused when non-empty: a private key must never be shipped to a browser.
 */

/**
 * Matches an IPv6 literal (hex groups, colons, an optional embedded IPv4 tail). A host name can never
 * contain a colon, so anything else with a colon in it is a mistake (usually `host:port`).
 *
 * @type {RegExp}
 */
const IPV6_LITERAL = /^[0-9a-fA-F]*:[0-9a-fA-F:.]*$/;

/**
 * The option names that would carry a certificate or key, with the reason each one is refused.
 *
 * @type {[keyof GrpcWebEndpointOptions, string][]}
 */
const REFUSED_PEM_OPTIONS = [
	[
		'grpcClientKey',
		'a private key must never be shipped to a browser; for mutual TLS install the client certificate in the browser / OS certificate store'
	],
	['grpcClientCert', 'a browser presents a client certificate only from its own certificate store; install it there'],
	['grpcCert', 'the browser verifies the server against its own trust store; install the CA there']
];

/**
 * Build the gRPC-web endpoint URL (`https://host:port`) for the generated client constructors.
 *
 * @param {GrpcWebEndpointOptions} options
 *   The host, optional port and security mode.
 * @returns {string}
 *   `https://<host>[:<port>]` (or `http://...` when `useSecureChannel` is `false`), with a bare IPv6
 *   host in brackets.
 * @throws {TypeError}
 *   When `host` is missing, carries a scheme or a port, `port` is not an integer in 1..65535, or
 *   `useSecureChannel` is not a boolean.
 * @throws {Error}
 *   When `grpcCert`, `grpcClientCert` or `grpcClientKey` is non-empty (see the module comment).
 */
function buildGrpcWebEndpoint(options) {
	if (options === undefined || options === null) {
		throw new TypeError('buildGrpcWebEndpoint() requires an options object');
	}
	for (const [name, reason] of REFUSED_PEM_OPTIONS) {
		/**
		 * The supplied PEM; only its presence is checked, its content is never rendered.
		 * @type {unknown}
		 */
		const pem = options[name];
		if (pem !== undefined && pem !== null && pem !== '') {
			throw new Error(`buildGrpcWebEndpoint(): option "${name}" is not supported by gRPC-web: ${reason}`);
		}
	}
	/** @type {unknown} */
	const host = options.host;
	if (typeof host !== 'string' || host.length === 0) {
		throw new TypeError('buildGrpcWebEndpoint(): option "host" is required and must be a non-empty string');
	}
	if (host.includes('/')) {
		throw new TypeError(
			'buildGrpcWebEndpoint(): option "host" must be a bare host name; the scheme follows "useSecureChannel"'
		);
	}
	/**
	 * The host as it appears in the URL: bare IPv6 literals are bracketed, `[...]` is kept as given.
	 * @type {string}
	 */
	let urlHost = host;
	if (!host.startsWith('[') && host.includes(':')) {
		if (!IPV6_LITERAL.test(host)) {
			throw new TypeError('buildGrpcWebEndpoint(): option "host" must not contain a port; use option "port"');
		}
		urlHost = `[${host}]`;
	}
	/** @type {unknown} */
	const port = options.port;
	/**
	 * The `:<port>` suffix, or empty to use the scheme's default port.
	 * @type {string}
	 */
	let portSuffix = '';
	if (port !== undefined && port !== null && port !== '') {
		/** @type {unknown} */
		const effectivePort = typeof port === 'string' && /^[0-9]+$/.test(port) ? Number(port) : port;
		if (
			typeof effectivePort !== 'number' ||
			!Number.isInteger(effectivePort) ||
			effectivePort < 1 ||
			effectivePort > 65535
		) {
			throw new TypeError('buildGrpcWebEndpoint(): option "port" must be an integer between 1 and 65535');
		}
		portSuffix = `:${effectivePort}`;
	}
	/** @type {unknown} */
	const useSecureChannel = options.useSecureChannel === undefined ? true : options.useSecureChannel;
	if (typeof useSecureChannel !== 'boolean') {
		throw new TypeError('buildGrpcWebEndpoint(): option "useSecureChannel" must be a boolean');
	}
	if (useSecureChannel) {
		return `https://${urlHost}${portSuffix}`;
	}
	console.warn(
		`ONDEWO gRPC-web: insecure (plaintext http) channel to ${urlHost}${portSuffix}; do not use in production`
	);
	return `http://${urlHost}${portSuffix}`;
}

module.exports = { buildGrpcWebEndpoint };
