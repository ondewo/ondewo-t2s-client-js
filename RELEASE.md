# Release History

*****************

## Release ONDEWO T2S Js Client 6.6.2

### Improvements

* [[OND211-2443]](https://ondewo.atlassian.net/browse/OND211-2443) TLS: new `auth/grpcWebEndpoint.js`
  (`buildGrpcWebEndpoint`) builds the gRPC-web endpoint URL for the generated clients per the ONDEWO TLS contract:
  `https://` by default, plaintext `http://` only with `useSecureChannel: false`, which logs a `console.warn` naming
  `host:port`. A bare IPv6 host is bracketed (`::1` becomes `https://[::1]:8443`), a `[...]` host is kept as given, and
  a host carrying a scheme, a path or a port, a port outside 1..65535 or a non-boolean `useSecureChannel` is refused.
* [[OND211-2443]](https://ondewo.atlassian.net/browse/OND211-2443) `grpcCert`, `grpcClientCert` and `grpcClientKey`
  are refused with an error naming the option, never its value: a browser verifies the server against its own trust
  store and presents a client certificate only from its own certificate store, and a private key must never be shipped
  to a browser. Mutual TLS from a browser works with a client certificate installed in the browser / OS certificate
  store, or with the gRPC-web proxy (Envoy) terminating TLS and using mutual TLS upstream.
* [[OND211-2443]](https://ondewo.atlassian.net/browse/OND211-2443) `OfflineTokenProvider` gains `toJSON()` and a Node
  `util.inspect` hook that render the access and refresh tokens as `***REDACTED***` (a token not yet set stays `null`),
  so `JSON.stringify`, `console.log` and `util.inspect` of a provider never print a token.
* [[OND211-2443]](https://ondewo.atlassian.net/browse/OND211-2443) README: new section "TLS, mutual TLS and
  certificates" (modes, the Envoy mutual-TLS setup, why gRPC-web has no keepalive / backoff channel options, and the
  Node.js SDK for mutual TLS from code with PEM files).

### Bug Fixes

* Auth: `login()` now rejects a Keycloak token response whose `refresh_token` is present but empty, instead of arming a refresh loop that can never succeed. The insecure-TLS escape hatch is pinned to a single frozen `rejectUnauthorized: false` agent option set.
* Release: the published npm tarball no longer ships `auth/*.spec.js`. `create_npm_package` strips test files from the `npm/` copy and writes an `npm/.npmignore` -- the repo-root `.npmignore` is never consulted, because `npm_release` publishes `./npm`. The release `git commit` also tolerates a build that produced nothing to stage.
* Tooling: `ondewo-proto-compiler` is pinned in **both** the submodule gitlink and `ONDEWO_PROTO_COMPILER_GIT_BRANCH`, so `make check_out_correct_submodule_versions` can no longer silently downgrade the submodule.
* CI: `npm test` now gates the whole hand-written surface (`auth/`, `examples/`) at 100% statements, branches, functions and lines with `--all --per-file`, and the new `npm run test:drift` fails the build when `package.json` and `.ci-package.json` disagree.

### Build

* Regenerated with [ondewo-proto-compiler 5.15.2](https://github.com/ondewo/ondewo-proto-compiler/releases/tag/5.15.2)
  (previous release: 5.11.0) against the unchanged API tag [6.6.0](https://github.com/ondewo/ondewo-t2s-api/releases/tag/6.6.0). The bundle embeds the `google-protobuf` runtime,
  now pinned to `^4.0.2` (was `^3.21.4`), the line that provides `reader.readStringRequireUtf8()` which the 5.15
  compiler emits. `tests/bundleStringRoundTrip.spec.js` loads the shipped bundle and round-trips a multi-byte string,
  so a generator / runtime mismatch fails the build instead of shipping.

### Tests and release notes

* `auth/grpcWebEndpoint.spec.js` and new `auth/offlineTokenProvider.spec.js` cases cover the endpoint builder and the
  token redaction under the 100% coverage gate.
* `tests/releaseNotes.spec.js` pins the Makefile's release-notes slice, every heading's spelling, one `*****`
  separator per section and a non-empty slice for the released version.

*****************

## Release ONDEWO T2S Js Client 6.6.1

### Bug Fixes

* [[OND221-2830]](https://ondewo.atlassian.net/browse/OND221-2830) Regenerated with [ondewo-proto-compiler 5.13.0](https://github.com/ondewo/ondewo-proto-compiler/releases/tag/5.13.0).
* [[OND221-2830]](https://ondewo.atlassian.net/browse/OND221-2830) No change to how the auth helper is consumed: this package ships a webpack bundle rather than a public-api barrel, and the auth helper is a Node-only `undici` consumer that does not belong in a browser bundle. It ships as its own CommonJS entry and is imported directly (`require('<pkg>/auth/offlineTokenProvider')`).
* [[OND221-2830]](https://ondewo.atlassian.net/browse/OND221-2830) Tooling: `conventional-pre-commit` now runs before `giticket` at the commit-msg stage - with giticket first, its `[OND221-2830] fix: ...` rewrite was no longer valid Conventional Commits and every commit on a ticket branch failed. `README.md` is prettier-ignored where `.prettierrc` sets `useTabs` and markdownlint's MD010 de-tabs the same blocks, and the codegen `docker run` invocations no longer pass `-it`, which fails outside a TTY.

*****************

## Release ONDEWO T2S Js Client 6.6.0

### Improvements

* Tracking API Version [6.6.0](https://github.com/ondewo/ondewo-t2s-api/releases/tag/6.6.0) ( [Documentation](https://ondewo.github.io/ondewo-t2s-api/) )

*****************

## Release ONDEWO T2S Js Client 6.5.0

### Improvements

* Tracking API Version [6.5.0](https://github.com/ondewo/ondewo-t2s-api/releases/tag/6.5.0) ( [Documentation](https://ondewo.github.io/ondewo-t2s-api/) )

*****************

## Release ONDEWO T2S Js Client 6.4.2

### Improvements

* Tracking API Version [6.4.2](https://github.com/ondewo/ondewo-t2s-api/releases/tag/6.4.2) ( [Documentation](https://ondewo.github.io/ondewo-t2s-api/) )

*****************

## Release ONDEWO T2S Js Client 6.4.1

### Improvements

* Tracking API Version [6.4.1](https://github.com/ondewo/ondewo-t2s-api/releases/tag/6.4.1) ( [Documentation](https://ondewo.github.io/ondewo-t2s-api/) )

*****************

## Release ONDEWO T2S Js Client 6.4.0

### Improvements

* Tracking API Version [6.4.0](https://github.com/ondewo/ondewo-t2s-api/releases/tag/6.4.0) ( [Documentation](https://ondewo.github.io/ondewo-t2s-api/) )

*****************

## Release ONDEWO T2S Js Client 6.2.0

### Improvements

* Tracking API Version [6.2.0](https://github.com/ondewo/ondewo-t2s-api/releases/tag/6.2.0) ( [Documentation](https://ondewo.github.io/ondewo-t2s-api/) )

*****************

## Release ONDEWO T2S Js Client 6.1.0

### Improvements

* Tracking API Version [6.1.0](https://github.com/ondewo/ondewo-t2s-api/releases/tag/6.1.0) ( [Documentation](https://ondewo.github.io/ondewo-t2s-api/) )

*****************

## Release ONDEWO T2S Js Client 6.0.0

### Improvements

* Tracking API Version [6.0.0](https://github.com/ondewo/ondewo-t2s-api/releases/tag/6.0.0) ( [Documentation](https://ondewo.github.io/ondewo-t2s-api/) )

*****************

## Release ONDEWO T2S Js Client 5.0.0

### Improvements

* Tracking API Version [5.0.0](https://github.com/ondewo/ondewo-t2s-api/releases/tag/5.0.0) ( [Documentation](https://ondewo.github.io/ondewo-t2s-api/) )

*****************

## Release ONDEWO T2S Js Client 4.3.0

### Improvements

* Tracking API Version [4.3.0](https://github.com/ondewo/ondewo-t2s-api/releases/tag/4.3.0) ( [Documentation](https://ondewo.github.io/ondewo-t2s-api/) )
* Track version 4.3.0 of [ONDEWO T2S API](https://github.com/ondewo/ondewo-t2s-api/releases/4.3.0)
* [[OND211-2039]](https://ondewo.atlassian.net/browse/OND211-2039) Implemented automated release for GitHub and NPM
* [[OND211-2039]](https://ondewo.atlassian.net/browse/OND211-2039) Added pre-commit hooks and adjusted files to them

*****************
