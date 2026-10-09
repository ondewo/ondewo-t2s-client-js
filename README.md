<div align="center">
  <table>
    <tr>
      <td>
        <a href="https://ondewo.com/en/products/natural-language-understanding/">
            <img width="400px" src="https://raw.githubusercontent.com/ondewo/ondewo-logos/master/ondewo_we_automate_your_phone_calls.png"/>
        </a>
      </td>
    </tr>
    <tr>
       <td align="center">
          <a href="https://www.linkedin.com/company/ondewo "><img width="40px" src="https://cdn-icons-png.flaticon.com/512/3536/3536505.png"></a>
          <a href="https://www.facebook.com/ondewo"><img width="40px" src="https://cdn-icons-png.flaticon.com/512/733/733547.png"></a>
          <a href="https://twitter.com/ondewo"><img width="40px" src="https://cdn-icons-png.flaticon.com/512/733/733579.png"> </a>
          <a href="https://www.instagram.com/ondewo.ai/"><img width="40px" src="https://cdn-icons-png.flaticon.com/512/174/174855.png"></a>
          <a href="https://badge.fury.io/js/%40ondewo%2Fondewo-t2s-client-js"><img src="https://badge.fury.io/js/%40ondewo%2Fondewo-t2s-client-js.svg" alt="npm version" height="32"></a>
       </td>
    </tr>
  </table>
  <h1 align="center">
    ONDEWO T2S Client Javascript
  </h1>
</div>

## Overview

`@ondewo/t2s-client-js` is a compiled version of the [ONDEWO T2S API](https://github.com/ondewo/ondewo-t2s-api) using the [ONDEWO PROTO COMPILER](https://github.com/ondewo/ondewo-proto-compiler). Here you can find the T2S API [documentation](https://ondewo.github.io).

ONDEWO APIs use [Protocol Buffers](https://github.com/google/protobuf) version 3 (proto3) as their Interface Definition Language (IDL) to define the API interface and the structure of the payload messages. The same interface definition is used for gRPC versions of the API in all languages.

## Setup

Using NPM:

```shell
npm i --save @ondewo/ondewo-t2s-client-js
```

Using GitHub:

```shell
git clone https://github.com/ondewo/ondewo-t2s-client-js.git ## Clone repository
cd ondewo-t2s-client-js                                      ## Change into repo-directoy
make setup_developer_environment_locally                     ## Install dependencies
```

## Package structure

The published tarball is the `npm/` folder built by `make create_npm_package` -- test specs are stripped
from it, so `auth/` ships the token provider and the gRPC-web endpoint builder only:

```
npm
├── api
│   ├── ondewo_t2s_api.js
│   ├── ondewo_t2s_api.min.js
│   └── ondewo_t2s_api.min.js.map
├── auth
│   ├── grpcWebEndpoint.js
│   └── offlineTokenProvider.js
├── .npmignore
├── LICENSE
├── package.json
└── README.md
```

## Authentication

Calls to the ONDEWO API are authenticated with a Keycloak bearer token. Bundle `auth/offlineTokenProvider.js` into your app, call `login()` to obtain a live token provider, then pass its `Authorization` header as gRPC-web metadata on every request:

```js
const { login } = require('@ondewo/ondewo-t2s-client-js/auth/offlineTokenProvider');

const tokenProvider = await login({
  keycloakUrl: 'https://auth.example.com/auth',
  realm: 'ondewo-ccai-platform',
  clientId: 'ondewo-nlu-cai-sdk-public',
  username: 'tech-user@example.com',
  password: 'super-secret'
});

// Pass this metadata to any T2S RPC, e.g. client.synthesize(request, metadata):
const metadata = { Authorization: tokenProvider.getAuthorizationHeader() }; // "Bearer <jwt>"

tokenProvider.stop(); // stop the background refresh loop when done
```

`login()` performs a one-time password login and then refreshes the short-lived access token in the background, so `getAuthorizationHeader()` always returns a valid `Bearer <jwt>` value. Use the canonical `Authorization` header casing. See `examples/client.js` and `examples/index.html` for a complete, runnable example.

## TLS, mutual TLS and certificates

This package talks **gRPC-web** (HTTP/1.1 or HTTP/2 through a gRPC-web proxy such as Envoy) from a **browser**. TLS is
therefore the browser's job: the browser negotiates TLS (never SSL), verifies the server certificate against its own
trust store, and, for mutual TLS, presents a client certificate from its own certificate store. JavaScript can neither
hand the browser a CA certificate nor a client certificate or private key, so this SDK accepts none of them.

The generated clients (e.g. `Text2SpeechPromiseClient`) take the endpoint URL as their first argument. Build it with
`buildGrpcWebEndpoint` from `auth/grpcWebEndpoint.js`, which picks the scheme from `useSecureChannel` and enforces the
rules below:

```js
const { buildGrpcWebEndpoint } = require('@ondewo/ondewo-t2s-client-js/auth/grpcWebEndpoint');

const endpoint = buildGrpcWebEndpoint({ host: 'ondewo.example.com', port: 443 }); // 'https://ondewo.example.com:443'
const client = new Text2SpeechPromiseClient(endpoint, null, null);
```

| Mode                           | Options                             | What the browser does                                                 |
|--------------------------------|-------------------------------------|-----------------------------------------------------------------------|
| Plaintext (not for production) | `useSecureChannel: false`           | `http://`; `console.warn` names `host:port`                           |
| TLS with system roots          | `useSecureChannel: true` (default)  | `https://`; the server certificate must chain to a trusted CA         |
| TLS with a custom CA           | `useSecureChannel: true` (default)  | install the CA in the OS / browser trust store (not possible from JS) |
| Mutual TLS                     | `useSecureChannel: true` (default)  | offers a client certificate from its certificate store when asked     |

For mutual TLS the proxy requests the client certificate and the browser offers one from its certificate store (the
user picks it, or a managed-device policy selects it). Alternatively the proxy terminates the browser's TLS and uses
mutual TLS towards the ONDEWO server.

Rules `buildGrpcWebEndpoint` enforces:

- `grpcCert`, `grpcClientCert` and `grpcClientKey` (the field names the other ONDEWO SDKs use for PEM content) are
  **refused** with an error when non-empty: a private key must never be shipped to a browser, and a CA or client
  certificate passed from JavaScript would be silently ignored. Empty strings (or leaving them out) mean plain TLS.
  This also covers half a pair (only a certificate or only a key) and `useSecureChannel: false` with an identity.
- `useSecureChannel` must be a boolean (the string `'false'` is an error, not "secure").
- `host` is a bare host name or IP address: no scheme, no port (pass `port`), no path. A bare IPv6 literal is bracketed
  (`::1` becomes `https://[::1]:8443`); `[::1]` is kept. Without `port` the scheme's default port is used.
- Error messages name the option, never its value.

**Node.js:** the generated bundle sends its requests through the browser's `XMLHttpRequest`, which Node does not have,
so this package cannot make gRPC calls from Node (only `auth/offlineTokenProvider.js` runs there). For Node, and for
mutual TLS from code with PEM files, use [ondewo-t2s-client-nodejs](https://github.com/ondewo/ondewo-t2s-client-nodejs), which takes
`grpcCert` / `grpcClientCert` / `grpcClientKey` as described in its README.

**Channel options:** gRPC-web has no keepalive, ping, reconnect-backoff or message-size options; the browser manages the
connection. The keepalive / backoff defaults of the native ONDEWO SDKs do not apply here.

### Mutual TLS at the proxy (Envoy)

The gRPC-web proxy decides whether a client certificate is required. A minimal Envoy downstream TLS context:

```yaml
transport_socket:
  name: envoy.transport_sockets.tls
  typed_config:
    "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.DownstreamTlsContext
    require_client_certificate: true
    common_tls_context:
      tls_certificates:
        - certificate_chain: { filename: /etc/envoy/server.pem }
          private_key: { filename: /etc/envoy/server.key }
      validation_context:
        trusted_ca: { filename: /etc/envoy/ca.pem }
```

### A test PKI with openssl

A CA, a server certificate with SANs, and a client certificate with the `clientAuth` extended key usage, packed as
PKCS#12 for import into the browser / OS certificate store. For tests only: the keys are unencrypted.

```bash
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 365 \
  -subj "/CN=Test CA" -keyout ca.key -out ca.pem

printf 'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1\nextendedKeyUsage=serverAuth\n' > server.ext
openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -subj "/CN=localhost" -keyout server.key -out server.csr
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 365 \
  -extfile server.ext -out server.pem

printf 'extendedKeyUsage=clientAuth\n' > client.ext
openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -subj "/CN=my-client" -keyout client.key -out client.csr
openssl x509 -req -in client.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 365 \
  -extfile client.ext -out client.pem
openssl pkcs12 -export -in client.pem -inkey client.key -certfile ca.pem -out client.p12  # asks for an export password

chmod 600 *.key client.p12
openssl verify -CAfile ca.pem server.pem client.pem
```

Import `ca.pem` into the trust store and `client.p12` into the certificate store of the browser / OS (Firefox keeps its
own stores: Settings, Privacy & Security, Certificates). Envoy uses `server.pem` / `server.key` and trusts `ca.pem` for
its clients.

### TLS security notes

- Never bundle a private key, a PKCS#12 file or its password into a web application: everything shipped to a browser
  is public.
- The Keycloak tokens are secrets too: `JSON.stringify(provider)` and `console.log(provider)` of the token provider
  render both tokens as `***REDACTED***` (`getAuthorizationHeader()` still returns the real one). Do not log the
  `Authorization` metadata yourself.
- A page served over `https` cannot call an `http` endpoint (mixed content); keep `useSecureChannel: true` outside
  local development.

### TLS troubleshooting

gRPC-web reports a failed TLS handshake as a network error (status `UNAVAILABLE` / code 14, or `UNKNOWN` / code 2 with
"Http response at 400 or 500 level"); the cause is in the browser's developer tools (Network / Console tab):

- **`net::ERR_CERT_AUTHORITY_INVALID`** (Chrome) / **`SEC_ERROR_UNKNOWN_ISSUER`** (Firefox): the server certificate is
  not signed by a CA the browser trusts. Install the CA in the trust store, or use a publicly trusted certificate.
- **`net::ERR_CERT_COMMON_NAME_INVALID`**: the host in the URL is not in the certificate's subject alternative names.
  Connect by a name that is, or add the name / IP to the certificate.
- **`net::ERR_BAD_SSL_CLIENT_AUTH_CERT`** / **`SSL_ERROR_HANDSHAKE_FAILURE_ALERT`**: the proxy requires a client
  certificate and the browser offered none, or one the proxy's `trusted_ca` does not accept (signed by another CA, or
  missing the `clientAuth` extended key usage).
- **"Mixed Content" / `net::ERR_SSL_PROTOCOL_ERROR`**: an `https` page calling `http`, or `useSecureChannel: true`
  against a plaintext port.
- **CORS errors** are not TLS errors: the proxy must answer the gRPC-web preflight (`Access-Control-Allow-Origin`,
  `-Headers` including `authorization`, `x-grpc-web`, `content-type`).

[comment]: <> (START OF GITHUB README)

## Build

The `make build` command is dependent on 2 `repositories` and their speciefied `version`:

- [ondewo-t2s-api](https://github.com/ondewo/ondewo-t2s-api) -- `T2S_API_GIT_BRANCH` in `Makefile`
- [ondewo-proto-compiler](https://github.com/ondewo/ondewo-proto-compiler) -- `ONDEWO_PROTO_COMPILER_GIT_BRANCH` in `Makefile`

Other than creating the proto-code, `build` also installs the `dev-dependencies` and changes the owner of the proto-code-files from `root` to the `current user`.

> :white_check_mark: The js-compiler (version ~4.1.1) will prompt to download webpack -- write yes / y to finish the build

## GitHub Repository - Release Automation

The repository is published to GitHub and NPM by the Automated Release Process of ONDEWO.

TODO after PR merge:

- checkout master

  ```shell
  git checkout master
  ```

- pull newest state

  ```shell
  git pull
  ```

- Adjust `ONDEWO_T2S_VERSION` in the `Makefile` <br><br>
- Add new Release Notes to `src/RELEASE.md` in following format:

  ```
  ## Release ONDEWO T2S Js Client X.X.X    <----- Beginning of Notes

  ...<NOTES>...

  *****************                             <----- End of Notes
  ```

- release

  ```shell
  make ondewo_release
  ```

  <br>
  The release process can be divided into 6 Steps:

1. `build` specified version of the `ondewo-t2s-api`
2. `commit and push` all changes in code resulting from the `build`
3. Publish the created `npm` folder to `npmjs.com`
4. Create and push the `release branch` e.g. `release/1.3.20`
5. Create and push the `release tag` e.g. `1.3.20`
6. Create a new `Release` on GitHub

> :warning: The Release Automation checks if the build has created all the proto-code files, but it does not check the code-integrity. Please build and test the generated code prior to starting the release process.

[comment]: <> (END OF GITHUB README)
