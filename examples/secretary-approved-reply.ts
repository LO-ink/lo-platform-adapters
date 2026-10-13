import {
  createSecretaryClient,
  type SecretaryOperations,
  type SecretaryTransport,
} from "@lo-ink/bot-sdk";

type ApprovedReply = SecretaryOperations["sendText"]["input"];

/** Call only after authenticating exact-proposal approval and atomically claiming it.
 * This consent check is not an approval implementation; owner ID alone proves none.
 */
export async function sendApprovedReply(
  transport: SecretaryTransport,
  approved: ApprovedReply,
  claimedOwnerId: string,
) {
  const { connectionId, context, requestId, text, quote } = approved;
  const reply: ApprovedReply = {
    connectionId,
    context: { ...context },
    requestId,
    text,
    ...(quote === undefined ? {} : { quote: { ...quote } }),
  };
  const secretary = createSecretaryClient(transport);
  const connection = await secretary.getConnection(reply.connectionId);
  if (
    !connection.enabled ||
    connection.ownerId !== claimedOwnerId ||
    connection.ownerId === reply.context.chatId ||
    connection.policyVersion !== reply.context.policyVersion ||
    !connection.rights.includes("receive_messages") ||
    !connection.rights.includes("send_messages")
  )
    return;
  // The bot retains this exact request ID, context and body after uncertainty.
  return secretary.sendText(reply);
}
