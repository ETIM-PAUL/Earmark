/** The fields of a /v1/tokens entry Earmark relies on. */
export interface TokenEntry {
  asset_id?: string;
  assetId?: string;
  symbol: string;
  blockchain: string;
  decimals: number;
}

/**
 * Find USDC on a chain in the token catalog. Never build asset ids by hand:
 * the catalog is the only source of truth.
 */
export function findUsdc(tokens: readonly TokenEntry[], chain = "near"): string {
  const hit = tokens.find((t) => t.symbol === "USDC" && t.blockchain === chain && t.decimals === 6);
  const id = hit?.asset_id ?? hit?.assetId;
  if (!id) throw new Error(`USDC on ${chain} is not in the token catalog`);
  return id;
}
