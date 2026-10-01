#!/usr/bin/env node
// Register TypeScript support in this process so the stdio transport keeps
// running as the process launched by the MCP client.
import { register } from 'tsx/esm/api';

register();
await import('../mcp/server.ts');
