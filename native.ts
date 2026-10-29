import { existsSync, accessSync, constants } from "node:fs";
import { dirname, join, resolve, delimiter } from "node:path";
import type { Profile } from "./profiles.js";
import { centralArgs } from "./profiles.js";

export function findNativeBridge(bridge: string, configured = ""): string {
  if (!["codex", "claude-code", "pi"].includes(bridge)) throw new Error("Unsupported native bridge");
  const roots = configured ? [configured] : [
    "/Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/server/dist/builtin-plugins",
    resolve(dirname(process.execPath), "../Resources/app.asar.unpacked/node_modules/bb-app/server/dist/builtin-plugins"),
    resolve(dirname(process.execPath), "../lib/node_modules/bb-app/server/dist/builtin-plugins"),
  ];
  for (const root of roots) {
    const path = join(root, `provider-${bridge}`, "dist/host.js");
    if (existsSync(path)) return path;
  }
  throw new Error("BB native bridge not found. Set Central's builtinPluginsDirectory to this machine's BB built-in plugins directory.");
}
export function shellQuote(value: string) { return "'" + value.replaceAll("'", "'\\''") + "'"; }
export function resolveOnPath(command: string): string {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const path = join(directory, command);
    try { accessSync(path, constants.X_OK); return path; } catch {}
  }
  throw new Error(`${command} is not installed on this machine`);
}
export function stripCentralProfile(args: string[]): string[] {
  const output: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--profile" || args[i] === "-p") { i++; continue; }
    if (args[i].startsWith("--profile=")) continue;
    output.push(args[i]);
  }
  return output;
}
export function codexWrapper(executable: string, originalPath: string, codexHome?: string): string {
  return `#!/usr/bin/env node\n` + `
const {spawn} = require('node:child_process');
const {readFileSync,writeFileSync,renameSync} = require('node:fs');
const {join} = require('node:path');
const strip = ${stripCentralProfile.toString()};
const args = process.argv.slice(2);
const home = ${JSON.stringify(codexHome)};
if (home) {
  let profile;
  for(let i=0;i<args.length;i++) {
    if(args[i]==='--profile'||args[i]==='-p') profile=args[++i];
    else if(args[i].startsWith('--profile=')) profile=args[i].slice(10);
  }
  if(profile) {
    if(!/^[a-zA-Z0-9_-]+$/.test(profile)) throw new Error('Invalid Central profile name');
    const config=readFileSync(join(home,profile+'.config.toml'));
    const temp=join(home,'config.'+process.pid+'.tmp');
    writeFileSync(temp,config,{mode:0o600});
    renameSync(temp,join(home,'config.toml'));
  }
}
const child = spawn(${JSON.stringify(executable)}, strip(process.argv.slice(2)), {stdio: 'inherit', env: {...process.env, PATH: ${JSON.stringify(originalPath)}}});
for (const signal of ['SIGTERM','SIGINT','SIGHUP']) process.on(signal, () => child.kill(signal));
child.on('error', () => process.exit(1));
child.on('exit', code => process.exit(code ?? 1));
`;
}
export function claudeWrapper(command: string, profile: Profile) {
  return `#!/bin/sh\nexec ${[command, ...centralArgs(profile, [])].map(shellQuote).join(" ")} "$@"\n`;
}
export function nativeLaunchEnv(profile: Profile, command: string, wrapper: string, dataDir: string): NodeJS.ProcessEnv {
  if (profile.bridge === "codex") return {
    BB_CODEX_BRIDGE_APP_SERVER_COMMAND: command,
    BB_CODEX_BRIDGE_APP_SERVER_ARGS: JSON.stringify(centralArgs(profile, ["app-server"])),
    CODEX_HOME: join(dataDir, "codex"),
  };
  if (profile.bridge === "claude-code") return { BB_CLAUDE_CODE_EXECUTABLE: wrapper };
  if (profile.bridge === "pi") return {
    BB_PI_BRIDGE_COMMAND: command, BB_PI_BRIDGE_ARGS: JSON.stringify(centralArgs(profile, [])),
  };
  throw new Error("Not a native profile");
}

// Only the public bridge export is used. No bundled BB files are patched or copied.
export const runner = `
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
const module = await import(pathToFileURL(process.env.CENTRAL_NATIVE_BRIDGE).href);
const bridge = module.experimental_providerBridge;
if (bridge?.experimental_apiVersion !== 1) throw new Error('Incompatible BB native bridge');
bridge.start?.(JSON.parse(process.env.CENTRAL_BRIDGE_CONTEXT));
createInterface({input: process.stdin, crlfDelay: Infinity}).on('line', line => bridge.handleLine(line)).on('close', () => {bridge.onClose?.(); process.exit(0)});
process.on('SIGTERM', () => {bridge.onSigterm?.(); process.exit(0)});
process.on('SIGINT', () => {bridge.onSigint?.(); process.exit(0)});
`;
