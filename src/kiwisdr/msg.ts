/** Parse the body of a KiwiSDR MSG frame into key/value pairs.
 *
 *  MSG body format: "key1=value1 key2=value2 ..."
 *  Values may contain '=' characters (only the first '=' in each token is the delimiter).
 */
export function parseMsgBody(body: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const token of body.trim().split(' ')) {
    if (!token) continue;
    const eq = token.indexOf('=');
    if (eq === -1) {
      params[token] = '';
    } else {
      params[token.slice(0, eq)] = token.slice(eq + 1);
    }
  }
  return params;
}
