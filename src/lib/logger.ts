import pino from "pino";

/**
 * Shared application logger.
 *
 * Emits strict JSON in production (for log aggregators like Datadog/ELK).
 * Pretty-printed in development for human readability.
 *
 * Usage:
 *   import { logger } from "./lib/logger.js";
 *   logger.info({ agentId }, "execute started");
 *   logger.error({ err, agentId }, "execute failed");
 */
export const logger = pino({
  name: "x402",
  level: process.env.LOG_LEVEL ?? "info",
  ...(process.env.NODE_ENV === "development" && {
    transport: {
      target: "pino-pretty",
      options: { colorize: true, translateTime: "SYS:HH:MM:ss.l" },
    },
  }),
});
