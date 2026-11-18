import { execFile } from 'node:child_process';
import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface AgentDiscoveredInstance {
  id: string;
  serverName: string;
  instanceName: string;
  fullTarget: string;
  port: number | null;
  version: string;
  serviceName?: string;
  serviceStatus: 'Running' | 'Stopped' | 'Unknown';
  availability: 'available' | 'stopped' | 'unreachable' | 'unknown';
  isDefaultInstance: boolean;
  isClustered?: boolean;
  source: 'windows_service' | 'windows_registry' | 'sql_browser_udp' | 'agent_probe';
}

export function parseWindowsServices(rawJson: string, hostname: string): AgentDiscoveredInstance[] {
  if (!rawJson.trim()) return [];
  const parsed = JSON.parse(rawJson) as
    | Array<{ Name?: string; DisplayName?: string; Status?: string | number }>
    | { Name?: string; DisplayName?: string; Status?: string | number };
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const out: AgentDiscoveredInstance[] = [];

  for (const svc of list) {
    const svcName = String(svc.Name || '');
    if (!svcName) continue;
    const upper = svcName.toUpperCase();
    if (upper !== 'MSSQLSERVER' && !upper.startsWith('MSSQL$')) continue;

    const isDefault = upper === 'MSSQLSERVER';
    const instanceName = isDefault ? 'MSSQLSERVER' : svcName.slice(6);
    const statusStr = String(svc.Status ?? '').toLowerCase();
    const isRunning = statusStr === 'running' || statusStr === '4';
    const isStopped = statusStr === 'stopped' || statusStr === '1';

    out.push({
      id: `svc_${svcName}`,
      serverName: hostname,
      instanceName,
      fullTarget: isDefault ? hostname : `${hostname}\\${instanceName}`,
      port: isDefault ? 1433 : null,
      version: String(svc.DisplayName || 'Microsoft SQL Server'),
      serviceName: svcName,
      serviceStatus: isRunning ? 'Running' : isStopped ? 'Stopped' : 'Unknown',
      availability: isRunning ? 'available' : isStopped ? 'stopped' : 'unknown',
      isDefaultInstance: isDefault,
      source: 'windows_service',
    });
  }
  return out;
}

export function parseSqlBrowserPacket(buf: Buffer, hostname: string): AgentDiscoveredInstance[] {
  if (buf.length < 4) return [];
  const text = buf.subarray(3).toString('utf8');
  const records = text.split(';;').map((r) => r.trim()).filter(Boolean);
  const out: AgentDiscoveredInstance[] = [];

  for (const rec of records) {
    const parts = rec.split(';');
    const kv: Record<string, string> = {};
    for (let i = 0; i + 1 < parts.length; i += 2) {
      kv[parts[i]] = parts[i + 1];
    }
    if (!kv.InstanceName) continue;
    const isDef = kv.InstanceName.toUpperCase() === 'MSSQLSERVER';
    const port = kv.tcp ? Number(kv.tcp) : null;
    out.push({
      id: `udp_${kv.ServerName || hostname}_${kv.InstanceName}`,
      serverName: kv.ServerName || hostname,
      instanceName: kv.InstanceName,
      fullTarget: isDef ? kv.ServerName || hostname : `${kv.ServerName || hostname}\\${kv.InstanceName}`,
      port: Number.isFinite(port) ? port : null,
      version: kv.Version ? `SQL Server ${kv.Version}` : 'Microsoft SQL Server',
      serviceStatus: 'Running',
      availability: 'available',
      isDefaultInstance: isDef,
      isClustered: kv.IsClustered === 'Yes',
      source: 'sql_browser_udp',
    });
  }
  return out;
}

async function probeUdpBrowser(host = '127.0.0.1'): Promise<AgentDiscoveredInstance[]> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const timer = setTimeout(() => {
      try {
        sock.close();
      } catch {
        // ignore
      }
      resolve([]);
    }, 1500);

    sock.on('message', (msg) => {
      clearTimeout(timer);
      try {
        sock.close();
      } catch {
        // ignore
      }
      resolve(parseSqlBrowserPacket(msg, os.hostname()));
    });

    sock.on('error', () => {
      clearTimeout(timer);
      try {
        sock.close();
      } catch {
        // ignore
      }
      resolve([]);
    });

    sock.send(Buffer.from([0x02]), 1434, host);
  });
}

async function probeTcp(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 800);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

export async function discoverLocalSqlOnWindows(): Promise<{
  hostname: string;
  osInfo: string;
  instances: AgentDiscoveredInstance[];
}> {
  const hostname = os.hostname();
  const osInfo = `${os.platform()} ${os.release()} (${os.arch()})`;
  if (process.platform !== 'win32') {
    return { hostname, osInfo, instances: [] };
  }

  const map = new Map<string, AgentDiscoveredInstance>();

  try {
    const cmd = `Get-Service | Where-Object { $_.Name -eq 'MSSQLSERVER' -or $_.Name -like 'MSSQL$*' } | Select-Object Name, DisplayName, @{Name='Status';Expression={$_.Status.ToString()}} | ConvertTo-Json -Compress`;
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], {
      timeout: 5000,
    });
    for (const item of parseWindowsServices(stdout, hostname)) {
      map.set(item.instanceName.toUpperCase(), item);
    }
  } catch {
    // ignore if restricted
  }

  try {
    const regCmd = `Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Microsoft SQL Server\\Instance Names\\SQL' -ErrorAction SilentlyContinue | Select-Object * -ExcludeProperty PSPath,PSParentPath,PSChildName,PSDrive,PSProvider | ConvertTo-Json -Compress`;
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', regCmd], {
      timeout: 4000,
    });
    if (stdout.trim()) {
      const obj = JSON.parse(stdout) as Record<string, string>;
      for (const instName of Object.keys(obj)) {
        const key = instName.toUpperCase();
        if (!map.has(key)) {
          const isDef = key === 'MSSQLSERVER';
          map.set(key, {
            id: `reg_${instName}`,
            serverName: hostname,
            instanceName: instName,
            fullTarget: isDef ? hostname : `${hostname}\\${instName}`,
            port: isDef ? 1433 : null,
            version: `SQL Server (${obj[instName]})`,
            serviceStatus: 'Unknown',
            availability: 'unknown',
            isDefaultInstance: isDef,
            source: 'windows_registry',
          });
        }
      }
    }
  } catch {
    // ignore
  }

  const udp = await probeUdpBrowser('127.0.0.1');
  for (const item of udp) {
    const key = item.instanceName.toUpperCase();
    const existing = map.get(key);
    if (existing) {
      existing.port = item.port ?? existing.port;
      existing.version = item.version || existing.version;
      existing.availability = 'available';
      existing.serviceStatus = 'Running';
    } else {
      map.set(key, item);
    }
  }

  for (const item of map.values()) {
    if (item.port) {
      const ok = await probeTcp('127.0.0.1', item.port);
      if (ok) item.availability = 'available';
      else if (item.serviceStatus === 'Running') item.availability = 'unreachable';
    }
  }

  if (map.size === 0 && (await probeTcp('127.0.0.1', 1433))) {
    map.set('MSSQLSERVER', {
      id: 'tcp_1433',
      serverName: 'localhost',
      instanceName: 'MSSQLSERVER',
      fullTarget: 'localhost',
      port: 1433,
      version: 'SQL Server TCP Listener (1433)',
      serviceStatus: 'Running',
      availability: 'available',
      isDefaultInstance: true,
      source: 'agent_probe',
    });
  }

  return {
    hostname,
    osInfo,
    instances: Array.from(map.values()),
  };
}
