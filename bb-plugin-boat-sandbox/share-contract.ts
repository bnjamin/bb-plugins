import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const shareContract = defineRpcContract({
  share: {
    input: z.object({
      workspacePath: z.string().min(1).refine((path) => path.startsWith("/"), "workspacePath must be absolute"),
      port: z.number().int().min(1).max(65535),
    }).strict(),
    output: z.object({
      url: z.string().url().refine((url) => new URL(url).protocol === "https:", "URL must use HTTPS"),
    }).strict(),
  },
});
