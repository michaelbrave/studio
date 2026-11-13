// OAuth state for each worker's T3 MCP endpoint, kept in one 0600 file per worker.
// T3 signs outside agents in with authorization code + PKCE and a loopback redirect
// (t3code docs/internals/environment-auth.md, "MCP clients are a separate audience").
// The redirect URI is registered but never listened on: pairing returns the code directly.

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

export const STUDIO_HOME = process.env.STUDIO_HOME ?? join(homedir(), ".config", "studio");
/** Fixed so the redirect URI registered with each worker stays valid across runs. */
export const CALLBACK_PORT = Number(process.env.STUDIO_OAUTH_PORT ?? 47615);

export interface WorkerRecord {
  name: string;
  /** The environment's MCP URL, e.g. https://desktop.tailnet.ts.net/mcp */
  url: string;
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  /** Bearer session for the worker's typed RPC (`/ws`, `/api/...`). */
  rpcToken?: string;
}

const workersDir = () => join(STUDIO_HOME, "workers");
const recordPath = (name: string) => join(workersDir(), `${name}.json`);

export async function readWorker(name: string): Promise<WorkerRecord> {
  try {
    return JSON.parse(await readFile(recordPath(name), "utf8")) as WorkerRecord;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`unknown worker "${name}"; run login first`);
    throw e;
  }
}

export async function writeWorker(record: WorkerRecord): Promise<void> {
  await mkdir(workersDir(), { recursive: true, mode: 0o700 });
  await writeFile(recordPath(record.name), JSON.stringify(record, null, 2), { mode: 0o600 });
  await chmod(recordPath(record.name), 0o600);
}

export class FileOAuthProvider implements OAuthClientProvider {
  private record: WorkerRecord;
  private readonly onAuthorize: (url: URL) => void | Promise<void>;

  constructor(record: WorkerRecord, onAuthorize: (url: URL) => void | Promise<void>) {
    this.record = record;
    this.onAuthorize = onAuthorize;
  }

  get redirectUrl() {
    return `http://127.0.0.1:${CALLBACK_PORT}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Studio hub",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  clientInformation() {
    return this.record.client;
  }
  async saveClientInformation(client: OAuthClientInformationMixed) {
    await this.save({ client });
  }
  tokens() {
    return this.record.tokens;
  }
  async saveTokens(tokens: OAuthTokens) {
    await this.save({ tokens });
  }
  async redirectToAuthorization(url: URL) {
    await this.onAuthorize(url);
  }
  async saveCodeVerifier(codeVerifier: string) {
    await this.save({ codeVerifier });
  }
  codeVerifier() {
    if (!this.record.codeVerifier) throw new Error("no PKCE code verifier saved");
    return this.record.codeVerifier;
  }
  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    const { name, url } = this.record;
    const next = { ...this.record };
    if (scope === "all" || scope === "client") delete next.client;
    if (scope === "all" || scope === "tokens") delete next.tokens;
    if (scope === "all" || scope === "verifier") delete next.codeVerifier;
    this.record = { ...next, name, url };
    await writeWorker(this.record);
  }

  private async save(patch: Partial<WorkerRecord>) {
    this.record = { ...this.record, ...patch };
    await writeWorker(this.record);
  }
}
