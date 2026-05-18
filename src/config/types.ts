import { z } from 'zod';

export const CONFIG_VERSION = '1';

/**
 * Per-adapter settings (model preference, base URL for local providers, etc.)
 * Free-form object; adapters interpret their own keys.
 */
export const AdapterConfigSchema = z.record(z.string(), z.unknown());
export type AdapterConfig = z.infer<typeof AdapterConfigSchema>;

export const AladeenConfigSchema = z.object({
  version: z.literal(CONFIG_VERSION),
  defaultAdapterId: z.string().min(1).optional(),
  enabledAdapters: z.array(z.string()).default([]),
  adapters: z.record(z.string(), AdapterConfigSchema).default({}),
  setupCompletedAt: z.string().optional(),
});

export type AladeenConfig = z.infer<typeof AladeenConfigSchema>;

export const DEFAULT_CONFIG: AladeenConfig = {
  version: CONFIG_VERSION,
  enabledAdapters: [],
  adapters: {},
};
