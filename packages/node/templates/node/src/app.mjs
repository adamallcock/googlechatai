import {
  GoogleChatAI,
  createChatRequestVerifier,
} from "googlechatai";

export function buildChat({
  source = "fixture",
  audience = null,
} = {}) {
  const chat = new GoogleChatAI({
    source,
    appUser: {
      name: process.env.GOOGLE_CHAT_APP_USER ?? "users/app",
    },
    ...(audience
      ? { verifier: createChatRequestVerifier({ audience }) }
      : {}),
  });

  chat.onMention((event, ctx) => {
    const prompt =
      event.message?.argumentText ??
      event.message?.plainTextForModel ??
      "your message";
    return ctx.reply.text(`You said: ${prompt}`);
  });

  chat.onMessage((event, ctx) =>
    ctx.reply.text(
      `Received: ${event.message?.plainTextForModel ?? event.kind}`,
    ),
  );

  return chat;
}

// Offline fixture replay uses this instance. The live server creates a
// separate instance with request verification enabled.
export const chat = buildChat();
