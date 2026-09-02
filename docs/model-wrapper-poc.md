# Custom-provider model wrapper proof of concept

This staging-only extension proves that Prime can expose wrapped copies of its
models while retaining Prime's native agent loop and exact `pi-ai` stream
protocol.

## Design

`src/model-wrapper.ts` snapshots native models into the `dsh-context` provider.
The public wrapper ID is an encoded `(source provider, source model id)` pair,
so equal model IDs from different providers cannot collide. The original source
`Model` object remains private.

At inference time the handler:

1. maps the wrapper ID back to the native model;
2. asks `ctx.modelRegistry.getApiKeyAndHeaders(source)` for **fresh source
   authentication**, including OAuth refresh and any resolved URL/environment;
3. dynamically imports the concrete `@earendil-works/pi-ai/api/<api>` module;
4. invokes that module's original `streamSimple(sourceModel, context, options)`;
5. returns a `lazyStream` which forwards every event object by identity.

It deliberately does not call `streamSimple` through the Models/provider
registry. Such a call using the selected `dsh-context` model would re-enter the
wrapper recursively. It also excludes its own provider from discovery.

This proof does not yet transform the `Context`; a DSH context service can be
inserted just before step 4 without changing Prime's event stream or agent loop.

## UX and lifecycle

Load the standalone extension explicitly during development:

```sh
prime-agent --extension ./extensions/model-wrapper-poc.ts
```

(`extensions/index.ts` and the package manifest are intentionally unchanged.)
After `session_start`, the extension auto-registers one `DSH Context · …` model
for every concrete API it supports. `/dsh-context` toggles between the selected
native model and its wrapper. Wrapped models also appear in Prime's normal model
selector. When a newly selected native model was not in the snapshot, the
catalog is republished immediately; registration of `dsh-context` itself never
triggers republishing.

The wrapper provider uses a non-secret internal placeholder solely so Prime
considers its catalog selectable. It disables the provider auth header. Actual
credentials are never copied into model definitions or stored under the wrapper
provider; only source-provider auth is resolved at request time. A source auth
failure becomes a terminal error event and the original API handler is not
loaded.

The current installed custom-provider API cannot enumerate the model registry
in the extension factory, so registration occurs on `session_start`, after the
initial extension load. It takes effect immediately (no `/reload`). An eventual
production integration may choose an explicit allowlist rather than duplicating
the entire native catalog.

## Verification

```sh
npm run check
```

`tests/model-wrapper.test.ts` uses a fake original stream and asserts:

- every forwarded event is the exact same object;
- the original native provider/model and fresh auth reach the fake handler;
- call headers override resolved source headers;
- self-wrapping is excluded and auth errors fail closed;
- provider/model pairs produce collision-free wrapper IDs.
