import type { HandlerResponse } from "@netlify/functions";
import serverless from "serverless-http";
import type { Application } from "express";

export function netlifyExpressAdapter(app: Application) {
  const handler = serverless(app);
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const body = request.method === "GET" || request.method === "HEAD" ? null : await request.text();
    const headers = Object.fromEntries(request.headers.entries());
    const queryStringParameters = Object.fromEntries(url.searchParams.entries());
    const result = await handler({
      httpMethod: request.method,
      path: url.pathname,
      rawPath: url.pathname,
      headers,
      multiValueHeaders: {},
      queryStringParameters,
      multiValueQueryStringParameters: {},
      body,
      isBase64Encoded: false,
      requestContext: {},
      resource: "/{proxy+}",
      pathParameters: null,
      stageVariables: null,
    } as never, {} as never) as HandlerResponse;
    const responseHeaders = new Headers();
    for (const [key, value] of Object.entries(result.headers ?? {})) {
      if (value !== undefined) responseHeaders.set(key, String(value));
    }
    for (const [key, values] of Object.entries(result.multiValueHeaders ?? {})) {
      for (const value of values) responseHeaders.append(key, value);
    }
    const responseBody = result.body
      ? result.isBase64Encoded ? Uint8Array.from(atob(result.body), (character) => character.charCodeAt(0)) : result.body
      : null;
    return new Response(responseBody, { status: result.statusCode ?? 200, headers: responseHeaders });
  };
}
