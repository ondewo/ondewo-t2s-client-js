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

// A STRING FIELD MUST SURVIVE A BINARY ROUND TRIP THROUGH THE SHIPPED BUNDLE.
//
// This is an ARTEFACT test. `api/ondewo_t2s_api.js` is a self-contained browser bundle: it embeds the
// `google-protobuf` runtime that was installed when it was built. The proto compiler now emits
// `reader.readStringRequireUtf8()`, a method that does not exist in google-protobuf 3.21.4 — and
// `src/package.json` pinned `^3.21.4`, a range that can never reach the 4.x line where it was added.
// A bundle built from those two therefore cannot decode ANY string field.
//
// This was not hypothetical here. It shipped to npm in the nlu (7.1.0-7.1.2), csi (5.5.0-5.5.3) and
// vtsi (8.7.0) js clients before it was caught, and this repository was armed for exactly the same
// outcome: with the old pin in place, a plain `make build` of this package produced a bundle with
// 106 `readStringRequireUtf8` call sites and a runtime with none of them. The committed bundle was
// fine only because it predated the compiler change.
//
// The .proto sources, the generated `_pb.js`, the auth suite and its coverage gate are all blind to
// it — only loading the SHIPPED BUNDLE and decoding a message can see it.
//
//   node --test tests/bundleStringRoundTrip.spec.js

'use strict';

const { test: runTestCase } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/** The generated, bundled API surface this package publishes. */
const BUNDLE_PATH = path.join(__dirname, '..', 'api', 'ondewo_t2s_api.js');

/**
 * Evaluate the browser bundle in an isolated context and hand back the global it defines.
 *
 * The context deliberately provides NO `require`: the bundle must be self-contained, which is the
 * whole point — whatever protobuf runtime it needs has to be inside it.
 *
 * @returns {any} the `ondewo_t2s_api` namespace object.
 */
function loadApiBundle() {
	const source = fs.readFileSync(BUNDLE_PATH, 'utf8');
	const context = { window: {}, global: {}, self: {} };
	context.globalThis = context;
	vm.createContext(context);
	vm.runInContext(source, context);
	assert.ok(context.ondewo_t2s_api, 'the bundle did not define the ondewo_t2s_api global');
	return context.ondewo_t2s_api;
}

runTestCase('a string field survives a binary round trip through the shipped bundle', () => {
	const api = loadApiBundle();
	assert.ok(api.Caching, 'the bundle does not export Caching');

	const original = new api.Caching();
	// A value with multi-byte characters, because the emitted reader is the UTF-8-validating one.
	const value = 'round-trip-probe-äöü';
	original.setCacheSaveDir(value);

	const bytes = original.serializeBinary();
	assert.ok(bytes.length > 0, 'serialization produced no bytes');

	// This is the line that throws when the bundle's runtime and its generated code disagree.
	const decoded = api.Caching.deserializeBinary(bytes);
	assert.equal(decoded.getCacheSaveDir(), value, 'the string did not survive the round trip');
});

runTestCase('the bundle carries a protobuf runtime able to read the strings it writes', () => {
	const api = loadApiBundle();
	const message = new api.Caching();
	message.setCacheSaveDir('probe');

	// Assert the PROPERTY, not the method name: what matters is that decoding works, not which
	// reader the generator happened to emit. A future generator may emit `readString` again.
	assert.doesNotThrow(
		() => api.Caching.deserializeBinary(message.serializeBinary()),
		'the bundled runtime cannot decode a string written by the same bundle'
	);
});
