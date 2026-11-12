/**
 * Adds Sentinel's shared Telegraph response fields without removing existing
 * endpoint-specific fields or mutating the original response object.
 *
 * @template {Record<string, unknown>} T
 * @param {T} response
 * @param {{ mode: 'wallet_risk' | 'fraud_knowledge', label: string, reason: string }} envelope
 * @returns {T & { mode: string, label: string, reason: string }}
 */
export function addResponseEnvelope(response, { mode, label, reason }) {
  return {
    ...response,
    mode,
    label,
    reason,
  };
}
