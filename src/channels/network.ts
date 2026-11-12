/** Failures that provably happened before the request reached the other side:
 *  no route, no name, nobody listening. Nothing was sent, so sending again
 *  cannot send twice. */
const PRE_CONNECT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETDOWN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);

/** Whether a failed request never left this machine. Reads the code off the
 *  error or off its cause — fetch reports a network failure as a TypeError
 *  wrapping the real one. */
export function failedBeforeConnecting(error: unknown): boolean {
  const code = (error as { code?: string })?.code ?? ((error as Error)?.cause as { code?: string })?.code;
  return code !== undefined && PRE_CONNECT_CODES.has(code);
}
