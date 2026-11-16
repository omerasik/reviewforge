import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { AppError } from "./domain.js";

export function secureMatch(left: string, right: string): boolean {
  const first = Buffer.from(left);
  const second = Buffer.from(right);
  return first.length === second.length && timingSafeEqual(first, second);
}

export async function rawBody(message: IncomingMessage, limit: number): Promise<Buffer> {
  if (Number(message.headers["content-length"]) > limit) throw new AppError(413, "body_too_large");
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of message.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > limit) throw new AppError(413, "body_too_large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

export function value(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new AppError(400, "invalid_json");
  }
}

export async function responseJson(response: Response, max: number): Promise<unknown> {
  if (!response.body) throw new Error("missing_body");
  const stream = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await stream.read();
      if (part.done) return value(Buffer.concat(chunks, length));
      length += part.value.length;
      if (length > max) {
        await stream.cancel().catch(() => undefined);
        throw new Error("response_too_large");
      }
      chunks.push(part.value);
    }
  } finally {
    stream.releaseLock();
  }
}
