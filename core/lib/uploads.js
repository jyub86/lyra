// Saves uploaded media into data/uploads with a collision-free name.
// Shared by the upload_media tool and the HTTP multipart endpoint.
import { mkdirSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { ulid } from "./ulid.js";
import { dataPath } from "./paths.js";

const UPLOAD_DIR = dataPath("uploads");

// `bytes`: ArrayBuffer | Uint8Array | Blob | Buffer (anything Bun.write accepts).
export async function saveUpload(filename, bytes) {
  mkdirSync(UPLOAD_DIR, { recursive: true });
  const ext = extname(filename || "").toLowerCase();
  const stored = ulid() + ext;
  await Bun.write(join(UPLOAD_DIR, stored), bytes);
  return { url: `/uploads/${stored}`, filename: basename(filename || stored) };
}
