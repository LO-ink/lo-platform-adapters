# Retired native secretary review example

This runnable native-draft example is retired. `run.mjs` terminates with a fixed
message before reading configuration, contacting the Bot API or opening state.
The old processor and state-opening exports fail with terminal `unsupported`.
They never replay a pending job or turn it into a delegated send.

Preserve existing state, locks, original request IDs, draft IDs and uncertain
outcomes. Do not remove another receiver, change webhooks or delete these files
to re-enable this example. A denial does not prove that an old send did not
commit. Reconcile historical results separately using original receipt and peer
evidence; keep state under your existing private retention policy.

AI proposals and their approval belong to the bot. LO keeps chat scope,
permissions, exact templates and schedules. See the
[bot-owned reply guide](../../docs/secretary.md) and
[typed consent check](../secretary-approved-reply.ts). The latter is only the
final delegated-send step, not an approval gate or a replacement poller.

The standalone authenticated webhook helper remains reusable for a bot-owned
processor. Authentication of a webhook is not owner approval of a proposal.

Tests verify terminal behavior, zero upstream calls and byte-preservation of
legacy state/locks; they do not claim a deployed bot-owned workflow.
