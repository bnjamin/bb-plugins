import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const shareContract = defineRpcContract({
  share: {
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({ url: z.url(), origin: z.url() }),
  },
});
