# Native integration and migration

## Prepared release order

1. SDK `@lo-ink/miniapp-sdk` 0.19.2: lifecycle fixes and distribution guards.
2. Native `@lo-ink/adapter-lo` 0.22.0: no automatic legacy composition.
3. Compatibility and outbound Telegram adapters 0.19.2 add conservative typed
   swipe controls.
4. `@lo-ink/adapter-lo-legacy` 0.1.0 and
   `@lo-ink/adapter-telegram-to-lo` 0.1.0: explicit migration integrations.
5. Update consumer lockfiles after registry artifacts and required host behavior
   are verified. Existing 0.21 consumers remain supported during migration.

These are prepared package versions. Passing CI or merging these sources does
not publish them to the registry or upgrade a released native application.

## Choose one direction

- New LO application: core SDK plus the native LO adapter.
- Existing LO SDK application on an older host: explicitly select the legacy LO
  adapter until its required native features are shipped.
- LO SDK application running in Telegram: use the Telegram host adapter.
- Existing Telegram WebApp application entering LO: install the separate inbound
  bridge before its entry module, then migrate calls incrementally.
- Existing server bot library entering LO: use the documented LO HTTP root and
  LO-issued credentials, audit its methods, then migrate toward the typed Bot SDK.

Do not select a host implicitly inside UI components. A composition root may
choose among adapters, but the domain code receives a client with capabilities.

## Acceptance before upgrading

Compile actual application call sites, install packed artifacts in isolation,
and exercise required host features. Include permission decline, teardown,
cancellation, delayed replies, theme/viewport changes and document reload.
Validate launch assertions on the backend using the actual provider. Never
infer identity from a browser global or strip/rewrite signed bytes.

The inbound bridge does not emulate all foreign methods. Native snapshot/event
coverage depends on the host port, and the native decoder does not currently
advertise invoices. Story/swipe controls require the associated LO host rollout;
older ports omit them. Use explicit older-host support when
necessary; record any missing native feature instead of claiming parity.
