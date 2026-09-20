import { z } from "zod";
import type { PluginSettingDescriptors } from "@get-bb/plugin-sdk";

export const providerId = "boat-sandbox";
const name = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
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
});
export type Config = z.infer<typeof configSchema>;
export const settingsDescriptors = {
  cliPath: { type: "string", label: "Boat CLI path", default: "", description: "Server-local executable. Blank searches PATH and ~/.ascii/bin/boat." },
  scope: { type: "string", label: "Billing scope", default: "personal", experimental_schema: name, description: "personal or a Boat organization ID. Existing machines retain their original scope." },
  environment: { type: "string", label: "Boat environment", default: "base", experimental_schema: name, description: "Existing named Boat environment used for credentials and tools." },
  snapshot: { type: "string", label: "Base snapshot", default: "", description: "Optional named Boat template. Use one that has never enrolled a BB daemon." },
  machineType: { type: "select", label: "Machine size", options: ["small", "default", "large", "xlarge"], default: "default" },
  ttlSeconds: { type: "number", label: "Runtime lease (seconds)", default: 3600, experimental_schema: z.number().int().min(1800).max(7200), description: "Renewed while BB is running; Boat auto-stops if BB goes offline." },
  idleMinutes: { type: "number", label: "Sleep after idle minutes", default: 30, experimental_schema: z.number().int().min(0).max(1440), description: "0 disables idle sleep. BB coordinates sleep with running work." },
} satisfies PluginSettingDescriptors;

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
