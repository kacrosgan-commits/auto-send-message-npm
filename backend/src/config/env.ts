import { z } from 'zod';

const boolFromEnv = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value == null || value.trim() === '') return defaultValue;
      return value.trim().toLowerCase() === 'true';
    });

const envSchema = z.object({
  DATABASE_URL: z.string().min(1).optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  BACKEND_API_KEY: z.string().optional().default(''),
  GOOGLE_CLIENT_ID: z.string().optional().default(''),
  GOOGLE_CLIENT_SECRET: z.string().optional().default(''),
  GOOGLE_REDIRECT_URI: z.string().optional().default(''),
  TOKEN_ENCRYPTION_KEY: z.string().optional().default(''),
  EMAIL_SEND_INTERVAL_MS: z.coerce.number().int().min(0).default(10_000),
  MAX_EMAILS_PER_HOUR: z.coerce.number().int().min(1).default(50),
  MAX_EMAILS_PER_DAY: z.coerce.number().int().min(1).default(200),
  APP_BASE_URL: z.string().optional().default(''),
  EXTENSION_ORIGIN: z.string().optional().default(''),
  ALLOW_REPEAT_CONTACT: boolFromEnv(false),
  INCLUDE_UNSUBSCRIBE_LINK: boolFromEnv(true),
  RUN_WORKER_IN_SERVER: boolFromEnv(false),
});

export interface AppConfig {
  databaseUrl: string;
  port: number;
  apiKey: string;
  googleClientId: string;
  googleClientSecret: string;
  googleRedirectUri: string;
  tokenEncryptionKey: string;
  emailSendIntervalMs: number;
  maxEmailsPerHour: number;
  maxEmailsPerDay: number;
  appBaseUrl: string;
  extensionOrigin: string;
  allowRepeatContact: boolean;
  includeUnsubscribeLink: boolean;
  runWorkerInServer: boolean;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid environment: ${message}`);
  }
  const env = parsed.data;
  return {
    databaseUrl: env.DATABASE_URL || '',
    port: env.PORT,
    apiKey: env.BACKEND_API_KEY.trim(),
    googleClientId: env.GOOGLE_CLIENT_ID.trim(),
    googleClientSecret: env.GOOGLE_CLIENT_SECRET.trim(),
    googleRedirectUri: env.GOOGLE_REDIRECT_URI.trim(),
    tokenEncryptionKey: env.TOKEN_ENCRYPTION_KEY,
    emailSendIntervalMs: env.EMAIL_SEND_INTERVAL_MS,
    maxEmailsPerHour: env.MAX_EMAILS_PER_HOUR,
    maxEmailsPerDay: env.MAX_EMAILS_PER_DAY,
    appBaseUrl: env.APP_BASE_URL.replace(/\/$/, ''),
    extensionOrigin: env.EXTENSION_ORIGIN.trim(),
    allowRepeatContact: env.ALLOW_REPEAT_CONTACT,
    includeUnsubscribeLink: env.INCLUDE_UNSUBSCRIBE_LINK,
    runWorkerInServer: env.RUN_WORKER_IN_SERVER,
  };
}
