/**
 * Centralized logging setup.
 * Exports a pino instance for application logs and an Express middleware
 * that attaches request-scoped logging with request IDs.
 */
import pino from "pino";
import pinoHttp from "pino-http";
import { LOG_LEVEL } from "./config.mjs";

/** Global application logger. */
export const logger = pino({ level: LOG_LEVEL });

/**
 * HTTP logging middleware used by Express to log each request/response.
 * Generates an id for each request if the upstream hasn't provided one.
 */
export const httpLogger = pinoHttp({
  logger,
  genReqId: (req) => req.headers["x-request-id"] || `${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
});

