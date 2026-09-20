import { z } from "zod";
import type { PluginSettingDescriptors } from "@get-bb/plugin-sdk";

export const providerId = "boat-sandbox";
const name = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
const developmentCommand = z.string().max(10000);
const developmentPort = z.number().int().min(0).max(65535);
const developmentDaemon = z.string().regex(/^[A-Za-z0-9_-]+$/);
const projectDevelopmentSchema = z.record(z.string().min(1), z.object({
  command: developmentCommand.optional(),
  port: developmentPort.optional(),
  daemon: developmentDaemon.optional(),
}).strict());
const projectDevelopmentJson = z.string().refine((value) => {
  try { return projectDevelopmentSchema.safeParse(JSON.parse(value)).success; } catch { return false; }
}, "Expected a JSON object keyed by project ID with command, port (0–65535), and/or daemon overrides.");
export const inputsSchema = z.object({
  snapshot: name.optional(),
  environment: name.optional(),
  machineType: z.enum(["small", "default", "large", "xlarge"]).optional(),
}).strict().default({});
export const configSchema = z.object({
  cliPath: z.string().default(""),
  scope: name.default("personal"),
  environment: name.default("base"),
  snapshot: z.union([name, z.literal("")]).default(""),
  machineType: z.enum(["small", "default", "large", "xlarge"]).default("default"),
  ttlSeconds: z.number().int().min(1800).max(7200).default(3600),
  idleMinutes: z.number().int().min(0).max(1440).default(30),
  developmentCommand: developmentCommand.default(""),
  developmentPort: developmentPort.default(0),
  developmentDaemon: developmentDaemon.default("rails"),
  projectDevelopment: projectDevelopmentJson.default("{}"),
});
export type Config = z.infer<typeof configSchema>;
export const settingsDescriptors = {
  developmentCommand: { type: "string", label: "Development command", default: "", experimental_schema: developmentCommand, description: "Command to start an app for share/dev. Blank makes share require a running app; dev falls back to mise run dev." },
  developmentPort: { type: "number", label: "Development port", default: 0, experimental_schema: developmentPort, description: "App port. 0 discovers the selected Pitchfork daemon's port." },
  developmentDaemon: { type: "string", label: "Development daemon", default: "rails", experimental_schema: developmentDaemon, description: "Pitchfork daemon used when the port is 0." },
  projectDevelopment: { type: "string", label: "Project development overrides", default: "{}", experimental_multiline: true, experimental_schema: projectDevelopmentJson, description: 'JSON keyed by BB project ID, e.g. {"proj_example":{"command":"npm run dev -- --host 0.0.0.0","port":5173}}. Omitted fields inherit defaults; command "" disables share startup and port 0 enables discovery.' },
  cliPath: { type: "string", label: "Boat CLI path", default: "", description: "Server-local executable. Blank searches PATH and ~/.ascii/bin/boat." },
  scope: { type: "string", label: "Billing scope", default: "personal", experimental_schema: name, description: "personal or a Boat organization ID. Existing machines retain their original scope." },
  environment: { type: "string", label: "Boat environment", default: "base", experimental_schema: name, description: "Existing named Boat environment used for credentials and tools." },
  snapshot: { type: "string", label: "Base snapshot", default: "", description: "Optional named Boat template. Use one that has never enrolled a BB daemon." },
  machineType: { type: "select", label: "Machine size", options: ["small", "default", "large", "xlarge"], default: "default" },
  ttlSeconds: { type: "number", label: "Runtime lease (seconds)", default: 3600, experimental_schema: z.number().int().min(1800).max(7200), description: "Renewed while BB is running; Boat auto-stops if BB goes offline." },
  idleMinutes: { type: "number", label: "Sleep after idle minutes", default: 30, experimental_schema: z.number().int().min(0).max(1440), description: "0 disables idle sleep. BB coordinates sleep with running work." },
} satisfies PluginSettingDescriptors;

export function developmentDefaults(config: Config, projectId: string) {
  const projects = projectDevelopmentSchema.parse(JSON.parse(config.projectDevelopment));
  const project = Object.hasOwn(projects, projectId) ? projects[projectId] : undefined;
  const command = project?.command ?? config.developmentCommand;
  const port = project?.port ?? config.developmentPort;
  return {
    ...(command ? { command } : {}),
    ...(port ? { port } : {}),
    daemon: project?.daemon ?? config.developmentDaemon,
  };
}

export const resourceSchema = z.object({
  version: z.literal(1),
  key: z.string().min(1),
  scope: name,
  accountIdentity: z.string().min(1),
  sandboxId: z.string().regex(/^bx_[A-Za-z0-9]+$/),
  ttlSeconds: z.number().int().min(1800).max(7200),
}).strict();
export type Resource = z.infer<typeof resourceSchema>;
export const allocationSchema = z.object({
  key: z.string().min(1), scope: name,
  accountIdentity: z.string().min(1),
  ttlSeconds: z.number().int().min(1800).max(7200),
  sandboxId: resourceSchema.shape.sandboxId.nullable(),
});
export type Allocation = z.infer<typeof allocationSchema>;
