/**
 * helm-client.ts — IPC Client + Auto-Launcher for `helm-daemon`
 *
 * Connects to the persistent `cli2cli-helm` daemon over Windows Named Pipe
 * (`\\.\pipe\cli2cli-helm`) or Unix Domain Socket. If the daemon is not yet
 * running, automatically spawns it detached in the background.
 */

import * as net from "node:net";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DEFAULT_PIPE_PATH, HelmDaemon } from "./helm-daemon.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON_SCRIPT = join(__dirname, "helm-daemon.js");

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export class HelmClient extends EventEmitter {
  private pipePath: string;
  private socket: net.Socket | null = null;
  private nextId = 1;
  private pending = new Map<number | string, PendingRequest>();
  private connecting: Promise<void> | null = null;

  constructor(pipePath: string = process.env.HELM_PIPE ?? DEFAULT_PIPE_PATH) {
    super();
    this.pipePath = pipePath;
  }

  private tryConnectOnce(timeoutMs = 1200): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this.pipePath);
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error("Connection timeout"));
      }, timeoutMs);

      sock.once("connect", () => {
        clearTimeout(timer);
        resolve(sock);
      });
      sock.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  private spawnDetachedDaemon(): void {
    const child = spawn(process.execPath, [DAEMON_SCRIPT], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        HELM_PIPE: this.pipePath
      }
    });
    child.unref();
  }

  public async ensureConnected(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      let sock: net.Socket | null = null;
      try {
        sock = await this.tryConnectOnce(600);
      } catch {
        // Daemon isn't running yet; try starting it detached or in-process fallback
        try {
          this.spawnDetachedDaemon();
          for (let attempt = 0; attempt < 15; attempt++) {
            await new Promise((r) => setTimeout(r, 150));
            try {
              sock = await this.tryConnectOnce(500);
              break;
            } catch {
              /* retry */
            }
          }
        } catch {
          /* ignore */
        }

        if (!sock) {
          // Fallback: host daemon inside current process if background spawn was blocked
          const inProc = new HelmDaemon(this.pipePath);
          await inProc.listen();
          sock = await this.tryConnectOnce(1000);
        }
      }

      this.attachSocket(sock);
    })();

    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private attachSocket(sock: net.Socket): void {
    this.socket = sock;
    sock.setEncoding("utf8");
    let buffer = "";

    sock.on("data", (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;

        try {
          const msg = JSON.parse(line) as {
            id?: number | string;
            method?: string;
            params?: unknown;
            result?: unknown;
            error?: { message?: string };
          };

          if (msg.id !== undefined && msg.id !== null) {
            const pend = this.pending.get(msg.id);
            if (pend) {
              this.pending.delete(msg.id);
              if (msg.error) {
                pend.reject(new Error(msg.error.message ?? "RPC error"));
              } else {
                pend.resolve(msg.result);
              }
            }
          } else if (msg.method) {
            this.emit("notification", msg.method, msg.params);
            this.emit(msg.method, msg.params);
          }
        } catch {
          /* ignore malformed frame */
        }
      }
    });

    sock.on("close", () => {
      this.socket = null;
      for (const [, pend] of this.pending) {
        pend.reject(new Error("Daemon connection closed"));
      }
      this.pending.clear();
      this.emit("close");
    });

    sock.on("error", () => {
      /* handled in close */
    });
  }

  public async request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<T> {
    await this.ensureConnected();
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject
      });
      try {
        this.socket!.write(payload);
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  public close(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }
}
