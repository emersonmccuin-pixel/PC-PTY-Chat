import type { PodMcpServerConfig } from '@pc/domain';

export function parsePodMcpServerConfig(v: unknown): PodMcpServerConfig {
  if (!v || typeof v !== 'object') {
    throw new Error('mcp server config must be an object');
  }
  const cfg = v as Record<string, unknown>;
  const out: PodMcpServerConfig = {};
  if (cfg.command !== undefined) {
    if (typeof cfg.command !== 'string') throw new Error('mcp.command must be a string');
    out.command = cfg.command;
  }
  if (cfg.args !== undefined) {
    if (!Array.isArray(cfg.args) || !cfg.args.every((a) => typeof a === 'string')) {
      throw new Error('mcp.args must be string[]');
    }
    out.args = cfg.args as string[];
  }
  if (cfg.env !== undefined) {
    if (!cfg.env || typeof cfg.env !== 'object' || Array.isArray(cfg.env)) {
      throw new Error('mcp.env must be an object of string=string');
    }
    const env: Record<string, string> = {};
    for (const [k, val] of Object.entries(cfg.env as Record<string, unknown>)) {
      if (typeof val !== 'string') throw new Error(`mcp.env.${k} must be a string`);
      env[k] = val;
    }
    out.env = env;
  }
  if (cfg.url !== undefined) {
    if (typeof cfg.url !== 'string') throw new Error('mcp.url must be a string');
    out.url = cfg.url;
  }
  return out;
}
