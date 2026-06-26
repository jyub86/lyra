// Saves uploaded media into data/uploads with a collision-free name.
// Shared by the upload_media tool and the HTTP multipart endpoint.
import { mkdirSync } from "node:fs";
import { join, dirname, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { ulid } from "./ulid.js";

const UPLOAD_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../data/uploads");

// `bytes`: ArrayBuffer | Uint8Array | Blob | Buffer (anything Bun.write accepts).
export async function saveUpload(filename, bytes) {
  mkdirSync(UPLOAD_DIR, { recursive: true });
  const ext = extname(filename || "").toLowerCase();
  const stored = ulid() + ext;
  await Bun.write(join(UPLOAD_DIR, stored), bytes);
  return { url: `/uploads/${stored}`, filename: basename(filename || stored) };
}
