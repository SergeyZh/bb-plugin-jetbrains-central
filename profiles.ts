import { z } from "zod";

export const profileSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  displayName: z.string().trim().min(1).max(80),
  agent: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  bridge: z.enum(["codex", "claude-code", "pi", "acp"]),
  runArgs: z.array(z.string()).default([]),
  args: z.array(z.string()).default([]),
}).strict();
export type Profile = z.infer<typeof profileSchema>;
export const defaults: Profile[] = [
  { id: "codex", displayName: "Codex JetBrains", agent: "codex", bridge: "codex", runArgs: [], args: [] },
  { id: "claude-code", displayName: "Claude Code JetBrains", agent: "claude", bridge: "claude-code", runArgs: [], args: [] },
  { id: "pi", displayName: "Pi JetBrains", agent: "pi", bridge: "pi", runArgs: [], args: [] },
];
export function parseProfiles(value: unknown): Profile[] {
  const profiles = z.array(profileSchema).max(32).parse(value);
  if (new Set(profiles.map(p => p.id)).size !== profiles.length) throw new Error("Central profile IDs must be unique");
  return profiles;
}
export function centralArgs(profile: Profile, args: string[]) {
  return ["run", profile.agent, ...profile.runArgs, "--", ...profile.args, ...args];
}
