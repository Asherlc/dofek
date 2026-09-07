import type { IncomingHttpHeaders } from "node:http";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { Duplex } from "node:stream";
import type express from "express";

class InProcessSocket extends Duplex {
  readonly #chunks: Buffer[] = [];

  get responseBody(): string {
    const rawResponse = Buffer.concat(this.#chunks).toString("utf8");
    const bodyStart = rawResponse.indexOf("\r\n\r\n");
    if (bodyStart === -1) {
      throw new Error("Response body separator was not found");
    }
    return rawResponse.slice(bodyStart + 4);
  }

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.#chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    callback();
  }
}

class InProcessRequest extends IncomingMessage {
  override headers: IncomingHttpHeaders;
  override method: string;
  override url: string;

  constructor(
    socket: Socket,
    payload: string,
    headers: IncomingHttpHeaders,
    path: string,
    method: string,
  ) {
    super(socket);
    this.headers = headers;
    this.method = method;
    this.url = path;
    this.push(payload);
    this.push(null);
  }

  override _read(): void {}
}

export async function postJsonInProcess(
  app: express.Express,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  return requestJsonInProcess(app, path, "POST", JSON.stringify(body), headers);
}

export async function getJsonInProcess(
  app: express.Express,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  return requestJsonInProcess(app, path, "GET", "", headers);
}

async function requestJsonInProcess(
  app: express.Express,
  path: string,
  method: string,
  payload: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  const socket = new InProcessSocket();
  const request = new InProcessRequest(
    new Socket(),
    payload,
    {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload).toString(),
      ...headers,
    },
    path,
    method,
  );

  const response: ServerResponse = Reflect.construct(ServerResponse, [request]);
  Reflect.apply(response.assignSocket, response, [socket]);

  return new Promise((resolve, reject) => {
    response.on("finish", () => {
      resolve({
        status: response.statusCode,
        body: JSON.parse(socket.responseBody),
      });
    });
    response.on("error", reject);
    request.on("error", reject);

    Reflect.apply(app, app, [
      request,
      response,
      (error: unknown) => {
        reject(error instanceof Error ? error : new Error("Request was not handled"));
      },
    ]);
  });
}
