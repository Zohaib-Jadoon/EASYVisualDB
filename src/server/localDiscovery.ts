import { execFile } from 'node:child_process';
import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';
import { promisify } from 'node:util';
import { DiscoveredSqlInstance, LocalDiscoveryResponse } from '../shared/types';

const execFileAsync = promisify(execFile);

export function parseWindowsSqlServicesJson(rawJson: string, hostname: string): DiscoveredSqlInstance[] {
  if (!rawJson.trim()) return [];
  const parsed = JSON.parse(rawJson) as
    | Array<{ Name?: string; DisplayName?: string; Status?: string | number }>
    | { Name?: string; DisplayName?: string; Status?: string | number };
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const results: DiscoveredSqlInstance[] = [];

  for (const svc of list) {
    const svcName = String(svc.Name || '');
    if (!svcName) continue;
    if (svcName.toUpperCase() !== 'MSSQLSERVER' && !svcName.toUpperCase().startsWith('MSSQL$')) continue;

    const isDefault = svcName.toUpperCase() === 'MSSQLSERVER';
    const instanceName = isDefault ? 'MSSQLSERVER' : svcName.slice(6);
    const fullTarget = isDefault ? hostname : `${hostname}\\${instanceName}`;
    const rawStatus = String(svc.Status ?? '').toLowerCase();
    const running = rawStatus === 'running' || rawStatus === '4';
    const stopped = rawStatus === 'stopped' || rawStatus === '1';

    results.push({
      id: `svc_${svcName}`,
      serverName: hostname,
      instanceName,
      fullTarget,
      port: isDefault ? 1433 : null,
      version: String(svc.DisplayName || 'Microsoft SQL Server'),
      serviceName: svcName,
      serviceStatus: running ? 'Running' : stopped ? 'Stopped' : 'Unknown',
      availability: running ? 'available' : stopped ? 'stopped' : 'unknown',
      isDefaultInstance: isDefault,
      source: 'windows_service',
    });
  }
  return results;
}

export function parseSqlBrowserUdpResponse(buf: Buffer, hostname: string): DiscoveredSqlInstance[] {
  if (buf.length < 4) return [];
  // First 3 bytes: 0x05 + 2-byte little-endian payload length
  const text = buf.subarray(3).toString('utf8');
  const records = text.split(';;').map((r) => r.trim()).filter(Boolean);
  const instances: DiscoveredSqlInstance[] = [];

  for (const rec of records) {
    const parts = rec.split(';');
    const kv: Record<string, string> = {};
    for (let i = 0; i + 1 < parts.length; i += 2) {
      kv[parts[i]] = parts[i + 1];
    }
    if (!kv.InstanceName) continue;
    const isDefault = kv.InstanceName.toUpperCase() === 'MSSQLSERVER';
    const port = kv.tcp ? Number(kv.tcp) : null;
    instances.push({
      id: `udp_${kv.ServerName || hostname}_${kv.InstanceName}`,
      serverName: kv.ServerName || hostname,
      instanceName: kv.InstanceName,
      fullTarget: isDefault ? kv.ServerName || hostname : `${kv.ServerName || hostname}\\${kv.InstanceName}`,
      port: Number.isFinite(port) ? port : null,
      version: kv.Version ? `SQL Server ${kv.Version}` : 'Microsoft SQL Server',
      serviceStatus: 'Running',
      availability: 'available',
      isDefaultInstance: isDefault,
      isClustered: kv.IsClustered === 'Yes',
      source: 'sql_browser_udp',
    });
  }
  return instances;
}

async function probeSqlBrowserUdp(host = '127.0.0.1', timeoutMs = 1500): Promise<DiscoveredSqlInstance[]> {
  return new Promise((resolve) => {
    const client = dgram.createSocket('udp4');
    const timer = setTimeout(() => {
      try {
        client.close();
      } catch {
        // ignore
      }
      resolve([]);
    }, timeoutMs);

    client.on('message', (msg) => {
      clearTimeout(timer);
      try {
        client.close();
      } catch {
        // ignore
      }
      resolve(parseSqlBrowserUdpResponse(msg, os.hostname()));
    });

    client.on('error', () => {
      clearTimeout(timer);
      try {
        client.close();
      } catch {
        // ignore
      }
      resolve([]);
    });

    const probePacket = Buffer.from([0x02]);
    client.send(probePacket, 1434, host);
  });
}

async function probeTcpPort(host: string, port: number, timeoutMs = 900): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
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

export async function discoverLocalWindowsSqlInstances(): Promise<LocalDiscoveryResponse> {
  const checkedAt = new Date().toISOString();
  const host = os.hostname();

  if (process.platform !== 'win32') {
    return {
      supported: false,
      hostPlatform: process.platform,
      viaAgentId: null,
      viaAgentName: null,
      instances: [],
      message: `Backend host is running on "${process.platform}". Direct local Windows service/registry discovery requires running the backend directly on Windows 11/Server OR pairing an online Windows Connector Agent.`,
      checkedAt,
    };
  }

  const map = new Map<string, DiscoveredSqlInstance>();

  // 1. PowerShell service inspection (explicit user-initiated read-only metadata query)
  try {
    const psScript = `Get-Service | Where-Object { $_.Name -eq 'MSSQLSERVER' -or $_.Name -like 'MSSQL$*' } | Select-Object Name, DisplayName, @{Name='Status';Expression={$_.Status.ToString()}} | ConvertTo-Json -Compress`;
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
      timeout: 5000,
    });
    for (const item of parseWindowsSqlServicesJson(stdout, host)) {
      map.set(item.instanceName.toUpperCase(), item);
    }
  } catch {
    // PowerShell query may be restricted; continue with UDP 1434 & TCP probes
  }

  // 2. Windows Registry instance names
  try {
    const psReg = `Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Microsoft SQL Server\\Instance Names\\SQL' -ErrorAction SilentlyContinue | Select-Object * -ExcludeProperty PSPath,PSParentPath,PSChildName,PSDrive,PSProvider | ConvertTo-Json -Compress`;
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psReg], {
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
            serverName: host,
            instanceName: instName,
            fullTarget: isDef ? host : `${host}\\${instName}`,
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
    // Registry key missing if no local SQL Server installed
  }

  // 3. SQL Server Browser UDP 1434 discovery
  const udpInstances = await probeSqlBrowserUdp('127.0.0.1');
  for (const inst of udpInstances) {
    const key = inst.instanceName.toUpperCase();
    const existing = map.get(key);
    if (existing) {
      existing.port = inst.port ?? existing.port;
      existing.version = inst.version || existing.version;
      existing.availability = 'available';
      existing.serviceStatus = 'Running';
    } else {
      map.set(key, inst);
    }
  }

  // 4. Verify TCP availability for default or known ports
  for (const inst of map.values()) {
    if (inst.port) {
      const reachable = await probeTcpPort('127.0.0.1', inst.port);
      if (reachable) {
        inst.availability = 'available';
      } else if (inst.serviceStatus === 'Running') {
        inst.availability = 'unreachable';
      }
    }
  }

  // Also probe localhost:1433 if nothing showed up in service list (e.g. local SQL container or Developer instance)
  if (map.size === 0 && (await probeTcpPort('127.0.0.1', 1433))) {
    map.set('MSSQLSERVER', {
      id: 'tcp_1433',
      serverName: 'localhost',
      instanceName: 'MSSQLSERVER',
      fullTarget: 'localhost',
      port: 1433,
      version: 'SQL Server TCP Listener (Port 1433)',
      serviceStatus: 'Running',
      availability: 'available',
      isDefaultInstance: true,
      source: 'windows_service',
    });
  }

  const instances = Array.from(map.values());
  return {
    supported: true,
    hostPlatform: 'win32',
    viaAgentId: null,
    viaAgentName: null,
    instances,
    message:
      instances.length > 0
        ? `Discovered ${instances.length} local SQL Server instance(s) on ${host}. Select an available instance and authenticate to browse its databases.`
        : `No local Microsoft SQL Server instances were detected on ${host}. Ensure SQL Server is installed or enter connection details manually.`,
    checkedAt,
  };
}
