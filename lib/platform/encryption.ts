import { requireSecret } from "./config";

const ENVELOPE_MAGIC = new Uint8Array([0x41, 0x4d, 0x41, 0x01]); // "AMA" + v1
const IV_BYTES = 12;
const KEY_BYTES = 32;

export type EncryptedArtifact = {
  /** Opaque ciphertext envelope safe to persist in object storage. */
  readonly body: Uint8Array;
  /** Identifier of the key that produced the envelope, persisted alongside it. */
  readonly encryptionKeyId: string;
  /** SHA-256 of the *plaintext*, used for integrity checks after decryption. */
  readonly plaintextSha256: string;
};

function decodeKeyMaterial(raw: string): Uint8Array {
  const normalized = raw.trim();
  const bytes = /^[a-f0-9]{64}$/i.test(normalized)
    ? Uint8Array.from(Buffer.from(normalized, "hex"))
    : Uint8Array.from(Buffer.from(normalized, "base64"));
  if (bytes.byteLength !== KEY_BYTES) {
    throw new Error(
      "ARTIFACT_ENCRYPTION_KEY must decode to exactly 32 bytes (base64 or hex).",
    );
  }
  return bytes;
}

async function hex(value: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function importKey(): Promise<{ key: CryptoKey; keyId: string }> {
  const material = decodeKeyMaterial(requireSecret("ARTIFACT_ENCRYPTION_KEY"));
  const buffer = material.buffer.slice(
    material.byteOffset,
    material.byteOffset + material.byteLength,
  ) as ArrayBuffer;
  const key = await crypto.subtle.importKey("raw", buffer, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
  // Key identity is derived from the key itself so a rotated key is detectable
  // without ever persisting key material.
  return { key, keyId: `k1_${(await hex(buffer)).slice(0, 24)}` };
}

export async function encryptArtifact(
  plaintext: string | Uint8Array,
): Promise<EncryptedArtifact> {
  const { key, keyId } = await importKey();
  const encoded =
    typeof plaintext === "string"
      ? new TextEncoder().encode(plaintext)
      : Uint8Array.from(plaintext);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded),
  );
  const body = new Uint8Array(
    ENVELOPE_MAGIC.length + iv.length + ciphertext.length,
  );
  body.set(ENVELOPE_MAGIC, 0);
  body.set(iv, ENVELOPE_MAGIC.length);
  body.set(ciphertext, ENVELOPE_MAGIC.length + iv.length);
  return {
    body,
    encryptionKeyId: keyId,
    plaintextSha256: await hex(encoded),
  };
}

export async function decryptArtifactBytes(input: {
  body: ArrayBuffer | Uint8Array;
  expectedKeyId?: string;
  expectedPlaintextSha256?: string;
}): Promise<Uint8Array> {
  const { key, keyId } = await importKey();
  if (input.expectedKeyId && input.expectedKeyId !== keyId) {
    throw new Error(
      "The stored artifact was encrypted with a different key identifier.",
    );
  }
  const body =
    input.body instanceof Uint8Array ? input.body : new Uint8Array(input.body);
  if (
    body.byteLength <= ENVELOPE_MAGIC.length + IV_BYTES ||
    !ENVELOPE_MAGIC.every((byte, index) => body[index] === byte)
  ) {
    throw new Error("The stored artifact envelope is malformed.");
  }
  const iv = body.slice(ENVELOPE_MAGIC.length, ENVELOPE_MAGIC.length + IV_BYTES);
  const ciphertext = body.slice(ENVELOPE_MAGIC.length + IV_BYTES);
  const plaintextBytes = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext),
  );
  if (
    input.expectedPlaintextSha256 &&
    (await hex(plaintextBytes)) !== input.expectedPlaintextSha256
  ) {
    throw new Error("The decrypted artifact does not match its recorded hash.");
  }
  return plaintextBytes;
}

export async function decryptArtifact(input: {
  body: ArrayBuffer | Uint8Array;
  expectedKeyId?: string;
  expectedPlaintextSha256?: string;
}): Promise<string> {
  return new TextDecoder().decode(await decryptArtifactBytes(input));
}
