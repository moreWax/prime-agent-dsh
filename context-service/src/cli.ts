#!/usr/bin/env node
import { createInterface } from "node:readline";
import { createServer, type Socket } from "node:net";
import { ContextService } from "./service.js";

const args = process.argv.slice(2); const socketIndex = args.indexOf("--socket");
if (args.includes("--help")) { console.log("Usage: dsh-context [--stdio | --socket PATH]"); process.exit(0); }
if (socketIndex >= 0) runSocket(args[socketIndex + 1]); else runStdio();
function serve(input: NodeJS.ReadableStream, output: NodeJS.WritableStream, close: () => void): void {
  const service = new ContextService(close); const rl = createInterface({ input });
  rl.on("line", line => { if (!line.trim()) return; let value: unknown; try { value = JSON.parse(line); } catch { value = null; } output.write(JSON.stringify(service.handle(value)) + "\n"); });
}
function runStdio(): void { serve(process.stdin, process.stdout, () => { process.stdin.pause(); process.exitCode = 0; }); }
function runSocket(path: string | undefined): void {
  if (!path) { console.error("--socket requires a Unix socket path"); process.exit(2); }
  const server = createServer((socket: Socket) => serve(socket, socket, () => { socket.end(); server.close(); }));
  server.on("error", e => { console.error(e.message); process.exitCode = 1; }); server.listen(path);
}
