import { createHash } from "node:crypto";
import type { GenerateIntentResponse, OwnerWallet, SignedData } from "@near-intents-agent-api/sdk";
import {
  actions,
  encodeDelegateAction,
  encodeSignedDelegate,
  JsonRpcProvider,
  KeyPair,
  KeyPairSigner,
  type KeyPairString,
  Signature,
} from "near-api-js";

// A NEAR owner whose key the backend holds. FOR DEV AND THE SPIKE ONLY:
// real senders sign in their own wallet in the browser, and Earmark never
// sees their keys. Use a dedicated low-value account.

export interface DevOwner {
  owner: Extract<OwnerWallet, { type: "near" }>;
  sign(generated: GenerateIntentResponse): Promise<SignedData>;
}

export function loadDevOwner(accountId: string, privateKey: string, rpcUrl: string): DevOwner {
  const keyPair = KeyPair.fromString(privateKey as KeyPairString);
  const publicKey = keyPair.getPublicKey().toString();
  const owner = { type: "near" as const, account_id: accountId, public_key: publicKey };
  return { owner, sign: (generated) => signAsNearOwner(generated, keyPair, rpcUrl) };
}

/**
 * Sign an owner intent exactly as a NEAR wallet would. The payload is
 * signed as returned; never rebuilt or reordered.
 * - nep413: an off-chain message signature
 * - nep366: a gasless delegate action the API's sponsor submits on chain
 */
export async function signAsNearOwner(
  generated: GenerateIntentResponse,
  keyPair: KeyPair,
  rpcUrl: string,
): Promise<SignedData> {
  const { intent, signer } = generated;
  const publicKey = keyPair.getPublicKey().toString();
  if (signer.type !== "near" || signer.public_key !== publicKey) {
    throw new Error("intent is for a different owner key");
  }

  if (intent.standard === "nep413") {
    const signed = await KeyPairSigner.fromSecretKey(keyPair.toString()).signNep413Message(
      signer.account_id,
      { ...intent.payload, nonce: Buffer.from(intent.payload.nonce, "base64") },
    );
    return {
      ...intent,
      public_key: publicKey,
      signature: Buffer.from(signed.signature).toString("base64"),
    };
  }

  if (intent.standard !== "nep366") {
    throw new Error(`a NEAR owner cannot sign ${intent.standard}`);
  }
  const provider = new JsonRpcProvider({ url: rpcUrl });
  const access = await provider.viewAccessKey({
    accountId: signer.account_id,
    publicKey,
    finalityQuery: { finality: "final" },
  });
  const delegateAction = {
    senderId: signer.account_id,
    receiverId: intent.payload.receiverId,
    publicKey: keyPair.getPublicKey(),
    nonce: access.nonce + 1n,
    maxBlockHeight: BigInt(access.block_height) + 120n,
    actions: intent.payload.actions.map(({ params }) =>
      actions.functionCall(
        params.methodName,
        Buffer.from(JSON.stringify(params.args)),
        BigInt(params.gas),
        BigInt(params.deposit),
      ),
    ),
  };
  const digest = createHash("sha256").update(encodeDelegateAction(delegateAction)).digest();
  const signature = new Signature({ keyType: 0, data: keyPair.sign(digest).signature });
  return {
    ...intent,
    signed_delegate: Buffer.from(encodeSignedDelegate({ delegateAction, signature })).toString(
      "base64",
    ),
  };
}
