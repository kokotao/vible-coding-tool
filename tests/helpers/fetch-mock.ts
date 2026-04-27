type FetchMockRoute = {
  match: string | RegExp | ((url: string, init?: RequestInit) => boolean);
  response: (input: { url: string; init?: RequestInit; bodyText: string }) => Response | Promise<Response>;
};

type FetchInput = string | URL | { url: string };
export function createFetchMock(routes: FetchMockRoute[]) {
  const calls: Array<{ url: string; init?: RequestInit; bodyText: string }> = [];

  const fetchImpl = async (input: FetchInput, init?: RequestInit) => {
    const url = normalizeUrl(input);
    const bodyText = await readBodyText(init?.body);
    const call = { url, init, bodyText };
    calls.push(call);

    const route = routes.find((candidate) => matches(candidate.match, url, init));
    if (!route) {
      return new Response("", { status: 404 });
    }

    return route.response(call);
  };

  return {
    calls,
    fetchImpl
  };
}

function matches(match: FetchMockRoute["match"], url: string, init?: RequestInit) {
  if (typeof match === "string") {
    return url === match;
  }
  if (match instanceof RegExp) {
    return match.test(url);
  }
  return match(url, init);
}

function normalizeUrl(input: FetchInput) {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

async function readBodyText(body: unknown) {
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body).toString("utf8");
  }
  if (body instanceof ArrayBuffer) {
    return Buffer.from(body).toString("utf8");
  }
  if (body && typeof (body as { text?: () => Promise<string> }).text === "function") {
    return await (body as { text: () => Promise<string> }).text();
  }
  return "";
}
