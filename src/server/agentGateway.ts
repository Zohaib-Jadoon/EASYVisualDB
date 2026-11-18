import crypto from 'node:crypto';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { AgentRpcRequest, AgentRpcResponse, DiscoveredSqlInstance } from '../shared/types';
import { controlPlane } from './controlPlane';

interface ActiveAgentSocket {
  agentId: string;
  workspaceId: string;
  ws: WebSocket;
  connectedAt: string;
  lastHeartbeatAt: string;
  discoveredInstances: DiscoveredSqlInstance[];
}

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

class AgentWebSocketGateway {
  private wss: WebSocketServer | null = null;
  private activeAgents = new Map<string, ActiveAgentSocket>();
  private pendingRpcs = new Map<string, PendingRpc>();

  attach(httpServer: HttpServer) {
    if (this.wss) return;
    this.wss = new WebSocketServer({ noServer: true });

    httpServer.on('upgrade', (request: IncomingMessage, socket, head) => {
      const reqUrl = request.url || '';
      if (!reqUrl.startsWith('/agent-ws')) {
        return;
      }
      this.wss!.handleUpgrade(request, socket, head, (ws) => {
        this.wss!.emit('connection', ws, request);
      });
    });

    this.wss.on('connection', (ws) => {
      let authenticatedAgentId: string | null = null;

      const authTimeout = setTimeout(() => {
        if (!authenticatedAgentId && ws.readyState === WebSocket.OPEN) {
          ws.close(4001, 'Agent authentication timeout');
        }
      }, 10000);

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
          if (msg.type === 'auth') {
            const token = String(msg.token || '');
            const record = controlPlane.authenticateAgentToken(token);
            if (!record) {
              ws.send(JSON.stringify({ type: 'auth_error', error: 'Invalid or unknown pairing token.' }));
              ws.close(4003, 'Invalid pairing token');
              return;
            }
            if (record.status === 'revoked') {
              ws.send(JSON.stringify({ type: 'auth_error', error: 'This Windows Agent has been revoked by an administrator.' }));
              ws.close(4003, 'Agent revoked');
              return;
            }

            clearTimeout(authTimeout);
            authenticatedAgentId = record.id;
            const now = new Date().toISOString();
            const nextStatus = record.status === 'pending_approval' ? 'pending_approval' : 'online';
            const discovered = Array.isArray(msg.discoveredInstances)
              ? (msg.discoveredInstances as DiscoveredSqlInstance[])
              : [];

            controlPlane.updateAgentTelemetry(record.id, {
              status: nextStatus,
              hostname: msg.hostname ? String(msg.hostname) : record.hostname,
              version: msg.version ? String(msg.version) : record.version,
              osInfo: msg.osInfo ? String(msg.osInfo) : undefined,
              discoveredCount: discovered.length,
              lastHeartbeatAt: now,
            });

            this.activeAgents.set(record.id, {
              agentId: record.id,
              workspaceId: record.workspaceId,
              ws,
              connectedAt: now,
              lastHeartbeatAt: now,
              discoveredInstances: discovered,
            });

            ws.send(
              JSON.stringify({
                type: 'auth_ok',
                agentId: record.id,
                workspaceId: record.workspaceId,
                status: nextStatus,
              })
            );
            return;
          }

          if (!authenticatedAgentId) {
            ws.send(JSON.stringify({ type: 'error', error: 'Authenticate before sending messages.' }));
            return;
          }

          if (msg.type === 'heartbeat') {
            const now = new Date().toISOString();
            const entry = this.activeAgents.get(authenticatedAgentId);
            if (entry) {
              entry.lastHeartbeatAt = now;
              if (Array.isArray(msg.discoveredInstances)) {
                entry.discoveredInstances = msg.discoveredInstances as DiscoveredSqlInstance[];
              }
            }
            const agents = entry ? controlPlane.listAgents(entry.workspaceId) : [];
            const current = agents.find((a) => a.id === authenticatedAgentId);
            if (current?.status === 'revoked') {
              ws.close(4003, 'Agent revoked');
              return;
            }
            controlPlane.updateAgentTelemetry(authenticatedAgentId, {
              status: current?.status === 'pending_approval' ? 'pending_approval' : 'online',
              lastHeartbeatAt: now,
              discoveredCount: entry?.discoveredInstances.length ?? 0,
            });
            ws.send(JSON.stringify({ type: 'heartbeat_ack', timestamp: now }));
            return;
          }

          if (msg.type === 'rpc_response') {
            const resp = msg as unknown as AgentRpcResponse;
            const pending = this.pendingRpcs.get(resp.requestId);
            if (pending) {
              clearTimeout(pending.timer);
              this.pendingRpcs.delete(resp.requestId);
              if (resp.ok) pending.resolve(resp.result);
              else pending.reject(new Error(resp.error || 'Windows Agent returned an error.'));
            }
          }
        } catch {
          // Ignore malformed frame
        }
      });

      ws.on('close', () => {
        clearTimeout(authTimeout);
        if (authenticatedAgentId) {
          this.activeAgents.delete(authenticatedAgentId);
          controlPlane.updateAgentTelemetry(authenticatedAgentId, {
            status: 'offline',
          });
        }
      });
    });
  }

  isAgentOnline(workspaceId: string, agentId: string): boolean {
    const entry = this.activeAgents.get(agentId);
    if (!entry || entry.workspaceId !== workspaceId) return false;
    return entry.ws.readyState === WebSocket.OPEN;
  }

  findOnlineAgentForWorkspace(workspaceId: string): ActiveAgentSocket | null {
    for (const entry of this.activeAgents.values()) {
      if (entry.workspaceId === workspaceId && entry.ws.readyState === WebSocket.OPEN) {
        return entry;
      }
    }
    return null;
  }

  async callAgent<T = unknown>(
    workspaceId: string,
    agentId: string,
    method: AgentRpcRequest['method'],
    payload: Record<string, unknown>,
    timeoutMs = 20000
  ): Promise<T> {
    const entry = this.activeAgents.get(agentId);
    if (!entry || entry.workspaceId !== workspaceId || entry.ws.readyState !== WebSocket.OPEN) {
      throw new Error(
        `Windows Connector Agent "${agentId}" is offline or not paired to this workspace. Start the agent on your Windows host and ensure it is approved.`
      );
    }

    const agents = controlPlane.listAgents(workspaceId);
    const rec = agents.find((a) => a.id === agentId);
    if (!rec || rec.status === 'revoked') {
      throw new Error('Windows Connector Agent has been revoked.');
    }
    if (rec.status === 'pending_approval') {
      throw new Error('Windows Connector Agent is awaiting administrator approval in Settings -> Windows Agents.');
    }

    const requestId = `rpc_${crypto.randomBytes(8).toString('hex')}`;
    const req: AgentRpcRequest = {
      type: 'rpc_request',
      requestId,
      method,
      payload,
    };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRpcs.delete(requestId);
        reject(new Error(`Windows Agent RPC "${method}" timed out after ${timeoutMs}ms.`));
      }, timeoutMs);

      this.pendingRpcs.set(requestId, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });

      entry.ws.send(JSON.stringify(req), (err) => {
        if (err) {
          clearTimeout(timer);
          this.pendingRpcs.delete(requestId);
          reject(new Error(`Failed to send request to Windows Agent: ${err.message}`));
        }
      });
    });
  }
}

export const agentGateway = new AgentWebSocketGateway();
