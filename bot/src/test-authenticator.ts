import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";

// A software passkey for tests: makes the same registration and assertion
// responses a phone or laptop would, signed with a real P-256 key, so the
// server's WebAuthn checks run for real. Not part of the build.

const head = (major: number, n: number): Buffer => {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
};

/** Just enough CBOR for an attestation object and a COSE key. */
function cbor(v: unknown): Buffer {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === "string") {
    const b = Buffer.from(v);
    return Buffer.concat([head(3, b.length), b]);
  }
  if (v instanceof Map) {
    return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  }
  throw new Error("unsupported CBOR value");
}

const b64 = (b: Buffer) => b.toString("base64url");
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest();

export interface AuthenticatorOptions {
  origin: string;
  rpID: string;
  /** Set false to behave like a device that skips the fingerprint or PIN. */
  userVerified?: boolean;
}

export class VirtualAuthenticator {
  readonly credentialId = randomBytes(16);
  private counter = 0;
  private userHandle = "";
  private readonly keys = generateKeyPairSync("ec", { namedCurve: "P-256" });

  constructor(private readonly o: AuthenticatorOptions) {}

  private flags(extra = 0) {
    return 0x01 | (this.o.userVerified === false ? 0 : 0x04) | extra;
  }

  /** The browser's answer to navigator.credentials.create(). */
  register(options: { challenge: string; user: { id: string } }) {
    this.userHandle = options.user.id;
    const jwk = this.keys.publicKey.export({ format: "jwk" }) as { x: string; y: string };
    const cose = cbor(
      new Map<number, unknown>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x, "base64url")],
        [-3, Buffer.from(jwk.y, "base64url")],
      ]),
    );
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([
      sha256(this.o.rpID),
      Buffer.from([this.flags(0x40)]),
      Buffer.alloc(4), // sign count 0
      Buffer.alloc(16), // AAGUID
      idLen,
      this.credentialId,
      cose,
    ]);
    const clientDataJSON = Buffer.from(
      JSON.stringify({
        type: "webauthn.create",
        challenge: options.challenge,
        origin: this.o.origin,
        crossOrigin: false,
      }),
    );
    const attestationObject = cbor(
      new Map<string, unknown>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]),
    );
    return {
      id: b64(this.credentialId),
      rawId: b64(this.credentialId),
      type: "public-key" as const,
      response: {
        clientDataJSON: b64(clientDataJSON),
        attestationObject: b64(attestationObject),
        transports: ["internal"],
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform" as const,
    };
  }

  /** The browser's answer to navigator.credentials.get(). */
  assert(options: { challenge: string }, over: { origin?: string } = {}) {
    this.counter += 1;
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.counter);
    const authData = Buffer.concat([sha256(this.o.rpID), Buffer.from([this.flags()]), count]);
    const clientDataJSON = Buffer.from(
      JSON.stringify({
        type: "webauthn.get",
        challenge: options.challenge,
        origin: over.origin ?? this.o.origin,
        crossOrigin: false,
      }),
    );
    const signature = sign(
      "sha256",
      Buffer.concat([authData, sha256(clientDataJSON)]),
      this.keys.privateKey,
    );
    return {
      id: b64(this.credentialId),
      rawId: b64(this.credentialId),
      type: "public-key" as const,
      response: {
        clientDataJSON: b64(clientDataJSON),
        authenticatorData: b64(authData),
        signature: b64(signature),
        userHandle: this.userHandle,
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform" as const,
    };
  }
}
