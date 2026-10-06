import {
  createSecretaryClient,
  type SecretaryOperations,
  type SecretaryTransport,
  type SecretaryUpdate,
} from "@lo-ink/bot-sdk";

type Proposal = SecretaryOperations["proposeDraft"]["input"];

/** The caller supplies a stable key and commits the exact proposal before I/O. */
export async function proposeForReview(
  transport: SecretaryTransport,
  update: SecretaryUpdate,
  requestId: string,
  persist: (proposal: Proposal) => Promise<void>,
) {
  if (update.kind !== "secretary_message" || update.message.secretaryBotId)
    return;
  const secretary = createSecretaryClient(transport);
  const connection = await secretary.getConnection(update.message.connectionId);
  if (
    !connection.enabled ||
    connection.policyVersion !== update.context.policyVersion ||
    connection.ownerId === update.message.senderId ||
    !connection.rights.includes("receive_messages") ||
    !connection.rights.includes("send_messages")
  )
    return;
  const proposal: Proposal = {
    connectionId: connection.id,
    context: update.context,
    requestId,
    text: "Your message was received. The owner will review this reply.",
    reason: "manual_review",
  };
  await persist(proposal);
  // The owner approves in LO; this call does not impersonate the owner API.
  return secretary.proposeDraft(proposal);
}
