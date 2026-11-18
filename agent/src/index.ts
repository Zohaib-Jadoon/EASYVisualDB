import os from 'node:os';
import WebSocket from 'ws';
import { discoverLocalSqlOnWindows } from './discovery.js';
import { handleAgentRpcMethod } from './mssqlRunner.js';

const SERVER_WS_URL = process.env.VDS_SERVER_WS_URL || 'ws://localhost:3000/agent-ws';
const PAIRING_TOKEN = process.env.VDS_PAIRING_TOKEN || '';
const AGENT_VERSION = '1.0.0-win-x64';

if (!PAIRING_TOKEN) {
  console.error('Missing VDS_PAIRING_TOKEN environment variable. Generate a pairing token in Visual Database Studio -> Settings -> Windows Agents.');
  process.exit(1);
}

let retryDelayMs = 2000;
let heartbeatTimer: NodeJS.Timeout | null = null;
let stopped = false;

async function connect() {
  if (stopped) return;
  const discovery = await discoverLocalSqlOnWindows().catch(() => ({
    hostname: os.hostname(),
    osInfo: `${os.platform()} ${os.release()}`,
    instances: [],
  }));

  console.log(`[VDS Agent] Connecting outbound to ${SERVER_WS_URL} from host ${discovery.hostname}...`);
  const ws = new WebSocket(SERVER_WS_URL);

  ws.on('open', () => {
    retryDelayMs = 2000;
    ws.send(
      JSON.stringify({
        type: 'auth',
        token: PAIRING_TOKEN,
        hostname: discovery.hostname,
        version: AGENT_VERSION,
        osInfo: discovery.osInfo,
        discoveredInstances: discovery.instances,
      })
    );

    heartbeatTimer = setInterval(async () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const latest = await discoverLocalSqlOnWindows().catch(() => discovery);
      ws.send(
        JSON.stringify({
          type: 'heartbeat',
          discoveredInstances: latest.instances,
        })
      );
    }, 15000);
  });

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (msg.type === 'auth_ok') {
        console.log(`[VDS Agent] Authenticated (agentId=${msg.agentId}, status=${msg.status}).`);
        return;
      }
      if (msg.type === 'auth_error') {
        console.error(`[VDS Agent] Authentication rejected: ${msg.error}`);
        stopped = true;
        ws.close();
        process.exit(1);
      }
      if (msg.type === 'rpc_request') {
        const requestId = String(msg.requestId || '');
        const method = String(msg.method || '');
        const payload = (msg.payload ?? {}) as Record<string, unknown>;

        try {
          let result: unknown;
          if (method === 'discover_instances') {
            result = await discoverLocalSqlOnWindows();
          } else {
            result = await handleAgentRpcMethod(method, payload);
          }
          ws.send(JSON.stringify({ type: 'rpc_response', requestId, ok: true, result }));
        } catch (err) {
          ws.send(
            JSON.stringify({
              type: 'rpc_response',
              requestId,
              ok: false,
              error: err instanceof Error ? err.message : 'Agent execution error.',
            })
          );
        }
      }
    } catch {
      // ignore malformed frame
    }
  });

  ws.on('close', (code, reason) => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (stopped) return;
    console.warn(`[VDS Agent] Disconnected (code=${code}, reason=${reason.toString()}). Retrying in ${retryDelayMs}ms...`);
    setTimeout(() => {
      retryDelayMs = Math.min(retryDelayMs * 2, 30000);
      connect().catch(() => undefined);
    }, retryDelayMs);
  });

  ws.on('error', (err) => {
    console.error(`[VDS Agent] Socket error: ${err.message}`);
  });
}

process.on('SIGINT', () => {
  stopped = true;
  process.exit(0);
});
process.on('SIGTERM', () => {
  stopped = true;
  process.exit(0);
});

connect().catch((err) => {
  console.error('[VDS Agent] Startup error:', err);
  process.exit(1);
});
