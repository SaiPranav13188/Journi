import { config } from '../config.js';

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export async function fetchJson(url, { timeoutMs = 15_000, headers = {}, ...init } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { 'User-Agent': config.userAgent, Accept: 'application/json', ...headers },
    });
    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!res.ok) {
      throw new HttpError(res.status, `Upstream request failed (${res.status})`, body);
    }
    return body;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new HttpError(504, `Upstream request timed out: ${new URL(url).host}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Wraps async route handlers so thrown errors reach the error middleware.
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
