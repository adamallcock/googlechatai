import http from "node:http";

import { buildChat } from "./app.mjs";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? "8787");
const audience = process.env.GOOGLE_CHAT_PROJECT_NUMBER?.trim();
const maxBodyBytes = Number(process.env.MAX_BODY_BYTES ?? 1_048_576);

if (!audience) {
  throw new Error(
    "GOOGLE_CHAT_PROJECT_NUMBER is required before the live callback server starts. Run `npm run doctor`.",
  );
}

const chat = buildChat({ source: "chat_http", audience });

async function readBody(request) {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (
    !Number.isFinite(maxBodyBytes) ||
    maxBodyBytes <= 0 ||
    (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes)
  ) {
    request.resume();
    const error = new Error("request_body_too_large");
    error.status = 413;
    throw error;
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBodyBytes) {
      request.resume();
      const error = new Error("request_body_too_large");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function toFetchHeaders(incomingHeaders) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incomingHeaders)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined) {
        headers.append(name, item);
      }
    }
  }
  return headers;
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? `${host}:${port}`}`,
  );

  if (request.method === "GET" && url.pathname === "/healthz") {
    sendJson(response, 200, { ok: true, service: "__PROJECT_NAME__" });
    return;
  }

  if (request.method !== "POST" || url.pathname !== "/chat/events") {
    sendJson(response, 404, { error: "not_found" });
    return;
  }

  try {
    const body = await readBody(request);
    const fetchRequest = new Request(url, {
      method: "POST",
      headers: toFetchHeaders(request.headers),
      body,
    });
    const fetchResponse = await chat.fetch(fetchRequest);
    response.writeHead(
      fetchResponse.status,
      Object.fromEntries(fetchResponse.headers.entries()),
    );
    response.end(await fetchResponse.text());
  } catch (error) {
    const status = Number(error?.status) === 413 ? 413 : 500;
    if (!response.headersSent) {
      sendJson(response, status, {
        error: status === 413 ? "request_body_too_large" : "internal_error",
      });
    } else {
      response.end();
    }
    if (status === 500) {
      console.error("Chat request failed without logging request content.");
    }
  }
});

server.listen(port, host, () => {
  console.log(`Listening on http://${host}:${port}/chat/events`);
});
