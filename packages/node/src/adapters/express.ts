import type { GoogleChatAI } from "../router/runtime.js";

const DEFAULT_MAX_BODY_BYTES = 1_048_576;

export interface ExpressLikeRequest {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
  rawBody?: string | Buffer;
  setEncoding?: (encoding: BufferEncoding) => void;
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
}

export interface ExpressLikeResponse {
  statusCode?: number;
  status?: (code: number) => ExpressLikeResponse;
  setHeader?: (name: string, value: string) => unknown;
  end?: (body?: string) => unknown;
  send?: (body?: string) => unknown;
}

export type ExpressLikeNext = (error?: unknown) => void;

export type ExpressLikeHandler = (
  req: ExpressLikeRequest,
  res: ExpressLikeResponse,
  next?: ExpressLikeNext,
) => Promise<void>;

export interface ExpressAdapterOptions {
  /**
   * Maximum decoded JSON request body size accepted by the adapter. When
   * Express has already populated `req.body`, configure matching upstream
   * `express.json({ limit })` middleware as the ingress memory limit.
   */
  maxBodyBytes?: number;
}

class RequestBodyTooLargeError extends Error {
  readonly maxBodyBytes: number;

  constructor(maxBodyBytes: number) {
    super(`Google Chat event payload exceeds the ${maxBodyBytes} byte limit.`);
    this.name = "RequestBodyTooLargeError";
    this.maxBodyBytes = maxBodyBytes;
  }
}

function normalizedMaxBodyBytes(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_MAX_BODY_BYTES;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("expressAdapter maxBodyBytes must be a positive safe integer.");
  }
  return value;
}

function assertBodySize(body: string, maxBodyBytes: number): void {
  if (Buffer.byteLength(body, "utf8") > maxBodyBytes) {
    throw new RequestBodyTooLargeError(maxBodyBytes);
  }
}

function declaredContentLength(req: ExpressLikeRequest): number | null {
  for (const [name, rawValue] of Object.entries(req.headers ?? {})) {
    if (name.toLowerCase() !== "content-length" || rawValue === undefined) {
      continue;
    }
    const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;
    if (value === undefined || !/^\d+$/.test(value.trim())) {
      return null;
    }
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function serializeBody(value: unknown): string {
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  if (typeof value === "string") {
    return value;
  }
  const serialized = JSON.stringify(value);
  if (typeof serialized !== "string") {
    throw new TypeError("Express request body must be JSON-serializable.");
  }
  return serialized;
}

function headersForRequest(
  headers: ExpressLikeRequest["headers"],
  hasBody: boolean,
): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (value === undefined) {
      continue;
    }
    result.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  if (hasBody && !result.has("content-type")) {
    result.set("content-type", "application/json");
  }
  return result;
}

function requestUrl(req: ExpressLikeRequest): string {
  return new URL(req.url ?? "/", "http://localhost").toString();
}

function requestMethod(req: ExpressLikeRequest): string {
  return (req.method ?? "GET").toUpperCase();
}

async function readRequestBody(
  req: ExpressLikeRequest,
  maxBodyBytes: number,
): Promise<string> {
  const contentLength = declaredContentLength(req);
  if (contentLength !== null && contentLength > maxBodyBytes) {
    throw new RequestBodyTooLargeError(maxBodyBytes);
  }

  if (req.body !== undefined) {
    const body = serializeBody(req.body);
    assertBodySize(body, maxBodyBytes);
    return body;
  }

  if (req.rawBody !== undefined) {
    const body = serializeBody(req.rawBody);
    assertBodySize(body, maxBodyBytes);
    return body;
  }

  if (!req.on) {
    return "";
  }

  return new Promise((resolve, reject) => {
    let body = "";
    let settled = false;
    req.setEncoding?.("utf8");
    req.on?.("data", (chunk) => {
      if (settled) {
        return;
      }
      body += String(chunk);
      try {
        assertBodySize(body, maxBodyBytes);
      } catch (error) {
        settled = true;
        reject(error);
      }
    });
    req.on?.("end", () => {
      if (!settled) {
        settled = true;
        resolve(body);
      }
    });
    req.on?.("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

async function writeExpressResponse(
  runtimeResponse: Response,
  res: ExpressLikeResponse,
): Promise<void> {
  if (res.status) {
    res.status(runtimeResponse.status);
  } else {
    res.statusCode = runtimeResponse.status;
  }

  runtimeResponse.headers.forEach((value, name) => {
    res.setHeader?.(name, value);
  });

  const body = await runtimeResponse.text();

  if (res.send) {
    res.send(body);
    return;
  }

  res.end?.(body);
}

export function expressAdapter(
  chat: GoogleChatAI,
  options: ExpressAdapterOptions = {},
): ExpressLikeHandler {
  const maxBodyBytes = normalizedMaxBodyBytes(options.maxBodyBytes);

  return async (req, res, next) => {
    try {
      const method = requestMethod(req);
      const canHaveBody = method !== "GET" && method !== "HEAD";
      const body = canHaveBody ? await readRequestBody(req, maxBodyBytes) : undefined;
      const request = new Request(requestUrl(req), {
        method,
        headers: headersForRequest(req.headers, body !== undefined && body.length > 0),
        ...(body !== undefined && body.length > 0 ? { body } : {}),
      });
      const response = await chat.fetch(request);
      await writeExpressResponse(response, res);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        await writeExpressResponse(
          new Response(
            JSON.stringify({
              error: {
                code: "payload_too_large",
                message: error.message,
              },
            }),
            {
              status: 413,
              headers: { "content-type": "application/json; charset=utf-8" },
            },
          ),
          res,
        );
        return;
      }
      if (next) {
        next(error);
        return;
      }

      throw error;
    }
  };
}
