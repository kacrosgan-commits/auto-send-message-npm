import { FastifyReply, FastifyRequest } from 'fastify';
import { AppConfig } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { safeEqual } from '../utils/crypto.js';

export function requireApiKey(config: AppConfig) {
  return async (request: FastifyRequest): Promise<void> => {
    const header = request.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    if (!config.apiKey || !token || !safeEqual(token, config.apiKey)) {
      throw new AppError(401, 'UNAUTHORIZED', 'Invalid or missing API key');
    }
  };
}

export function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof AppError) {
    return reply.status(error.statusCode).send({
      error: { code: error.code, message: error.message, details: error.details },
    });
  }
  const validation = error as { validation?: unknown; statusCode?: number; message?: string };
  if (validation?.validation) {
    return reply.status(400).send({
      error: { code: 'VALIDATION_ERROR', message: 'Request validation failed', details: { issues: validation.validation } },
    });
  }
  requestLog(reply, error);
  return reply.status(500).send({
    error: { code: 'INTERNAL', message: 'Internal server error', details: {} },
  });
}

function requestLog(reply: FastifyReply, error: unknown) {
  reply.log.error({ err: error }, 'unhandled error');
}
