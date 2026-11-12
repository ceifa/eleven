import type { IncomingMessage, ServerResponse } from "node:http";

/** One API request, as a handler sees it. */
export interface ApiRequest {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  /** The path's `:name` segments (and `*`, the rest of it), exactly as they
   *  arrived: nothing is URL-decoded here. */
  params: Record<string, string>;
  /** Answer with JSON. */
  send(status: number, payload: unknown): void;
  /** Answer with bytes, compressed when that is worth it. */
  deliver(status: number, headers: Record<string, string>, body: Buffer): void;
}

export interface Route {
  method: string;
  /**
   * The path under `/api`, matched whole. A segment is literal text, `:name`
   * (one segment of anything, at least one character), `:name(a|b)` (one of
   * the listed words) or a final `*` (whatever is left, slashes and nothing
   * included).
   */
  pattern: string;
  handler(request: ApiRequest): unknown;
}

export type Router = (method: string, path: string) => { route: Route; params: Record<string, string> } | undefined;

/** The first route in the table that fits wins. */
export function createRouter(routes: Route[]): Router {
  const table = routes.map((route) => ({ route, ...compile(route.pattern) }));
  return (method, path) => {
    for (const { route, regexp, names } of table) {
      if (route.method !== method) continue;
      const match = regexp.exec(path);
      if (match) return { route, params: Object.fromEntries(names.map((name, index) => [name, match[index + 1]])) };
    }
    return undefined;
  };
}

function compile(pattern: string): { regexp: RegExp; names: string[] } {
  const names: string[] = [];
  const source = pattern
    .split("/")
    .map((segment, index, segments) => {
      if (segment === "*" && index === segments.length - 1) {
        names.push("*");
        return "([^]*)";
      }
      const param = /^:(\w+)(?:\(([\w|]+)\))?$/.exec(segment);
      if (!param) return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      names.push(param[1]);
      return param[2] ? `(${param[2]})` : "([^/]+)";
    })
    .join("/");
  return { regexp: new RegExp(`^${source}$`), names };
}
