import http from "node:http";

import { GoogleChatAI } from "../../packages/node/dist/index.js";

const port = Number(process.env.PORT ?? "8787");

const chat = new GoogleChatAI({
  source: "fixture",
  appUser: { name: process.env.GOOGLE_CHAT_APP_USER ?? "users/app" },
  logger: {
    info(message, metadata) {
      console.log(JSON.stringify({ severity: "INFO", message, ...metadata }));
    },
    warn(message, metadata) {
      console.warn(JSON.stringify({ severity: "WARNING", message, ...metadata }));
    },
    error(message, metadata) {
      console.error(JSON.stringify({ severity: "ERROR", message, ...metadata }));
    },
  },
});

chat.use(async (event, _ctx, next) => {
  console.log(
    JSON.stringify({
      severity: "INFO",
      message: "example.event.received",
      eventKind: event.kind,
      eventId: event.eventId,
    }),
  );
  return next();
});

chat.onMessage(async (event, ctx) => {
  const attachments = await ctx.ai.attachments();
  const suffix =
    attachments.length > 0 ? ` (${attachments.length} attachment metadata item(s))` : "";
  return ctx.reply.text(
    `Local runtime received: ${event.message?.plainTextForModel ?? event.kind}${suffix}`,
  );
});

chat.onMention(async (event, ctx) => {
  const notes = await ctx.ai.relationshipSystemNotes();
  return ctx.reply.text(
    `Mention handled locally: ${event.message?.argumentText ?? event.message?.plainTextForModel ?? ""}${
      notes.length > 0 ? `\n${notes.join("\n")}` : ""
    }`,
  );
});

chat.onCardClicked((_event, ctx) =>
  ctx.reply.json({ actionResponse: { type: "UPDATE_MESSAGE" } }),
);

chat.onDialogSubmitted((_event, ctx) =>
  ctx.reply.json({
    actionResponse: {
      type: "DIALOG",
      dialogAction: { actionStatus: "OK" },
    },
  }),
);

chat.onUnknownEvent((event, ctx) =>
  ctx.reply.text(`No local handler is registered for ${event.rawKind ?? "unknown"}.`),
);

async function readTextBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

async function sendFetchResponse(response, fetchResponse) {
  response.writeHead(
    fetchResponse.status,
    Object.fromEntries(fetchResponse.headers.entries()),
  );
  response.end(await fetchResponse.text());
}

function toFetchHeaders(headers) {
  const fetchHeaders = new Headers();

  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        fetchHeaders.append(name, item);
      }
    } else if (value !== undefined) {
      fetchHeaders.set(name, String(value));
    }
  }

  return fetchHeaders;
}

const server = http.createServer(async (request, response) => {
  const origin = `http://${request.headers.host ?? `127.0.0.1:${port}`}`;
  const url = new URL(request.url ?? "/", origin);

  if (request.method === "GET" && url.pathname === "/healthz") {
    sendJson(response, 200, {
      ok: true,
      service: "googlechatai-node-local-runtime",
    });
    return;
  }

  if (url.pathname === "/chat/events") {
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await readTextBody(request);
    const requestInit = {
      method: request.method,
      headers: toFetchHeaders(request.headers),
    };

    if (body !== undefined) {
      requestInit.body = body;
    }

    const fetchRequest = new Request(url, requestInit);

    await sendFetchResponse(response, await chat.fetch(fetchRequest));
    return;
  }

  sendJson(response, 404, {
    ok: false,
    paths: ["/healthz", "/chat/events"],
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(
    JSON.stringify({
      severity: "INFO",
      message: "example.server.started",
      url: `http://127.0.0.1:${port}/chat/events`,
    }),
  );
});
