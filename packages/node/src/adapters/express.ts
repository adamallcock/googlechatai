import type { GoogleChatAI } from "../router/runtime.js";

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

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  return value.length > 0 ? JSON.parse(value) : {};
}

async function readRequestBody(req: ExpressLikeRequest): Promise<unknown> {
  if (req.body !== undefined) {
    return parseMaybeJson(req.body);
  }

  if (req.rawBody !== undefined) {
    return parseMaybeJson(
      Buffer.isBuffer(req.rawBody) ? req.rawBody.toString("utf8") : req.rawBody,
    );
  }

  if (!req.on) {
    return {};
  }

  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding?.("utf8");
    req.on?.("data", (chunk) => {
      body += String(chunk);
    });
    req.on?.("end", () => {
      try {
        resolve(parseMaybeJson(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on?.("error", reject);
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

export function expressAdapter(chat: GoogleChatAI): ExpressLikeHandler {
  return async (req, res, next) => {
    try {
      const rawPayload = await readRequestBody(req);
      const response = await chat.handlePayload(rawPayload);
      await writeExpressResponse(response, res);
    } catch (error) {
      if (next) {
        next(error);
        return;
      }

      throw error;
    }
  };
}
