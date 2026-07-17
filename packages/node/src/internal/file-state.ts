import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Coordinates read-modify-write operations on a file inside one Node.js
 * runtime. File-backed SDK stores are intentionally local-development
 * helpers: this is not a cross-process lock or a multi-instance primitive.
 */
const locks = new Map<string, Promise<void>>();

export async function withFileStateLock<T>(
  filePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = path.resolve(filePath);
  const previous = locks.get(key) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const own = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => own);
  locks.set(key, tail);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release?.();
    if (locks.get(key) === tail) {
      locks.delete(key);
    }
  }
}

export function temporaryFilePath(filePath: string): string {
  return `${filePath}.${process.pid}.${randomUUID()}.tmp`;
}

export async function writeFileAtomically(
  filePath: string,
  content: string | Uint8Array,
  options: { mode?: number; directoryMode?: number } = {},
): Promise<void> {
  const mode = options.mode ?? 0o600;
  const temporary = temporaryFilePath(filePath);
  await fs.mkdir(path.dirname(filePath), {
    recursive: true,
    mode: options.directoryMode ?? 0o700,
  });
  try {
    await fs.writeFile(temporary, content, { mode });
    await fs.rename(temporary, filePath);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
  try {
    await fs.chmod(filePath, mode);
  } catch {
    // Some platforms (for example Windows) reject POSIX mode bits.
  }
}
