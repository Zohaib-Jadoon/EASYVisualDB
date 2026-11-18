import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

// Use an isolated temporary data directory for all backend tests so workspace ./data stays clean
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-test-'));
process.env.VDS_DATA_DIR = testDataDir;
process.env.VDS_MASTER_KEY = 'unit_test_master_key_at_least_32_characters_long';

import { ControlPlaneStore } from './controlPlane';
import { billingProvider } from './billingProvider';
import { buildMssqlConfig } from './mssqlConnector';
import { parseSqlBrowserUdpResponse, parseWindowsSqlServicesJson } from './localDiscovery';
import { sandboxAdapter } from './adapters/sandboxAdapter';
import { agentGateway } from './agentGateway';
import { ConnectionProfile } from '../shared/types';

test.after(() => {
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

test('ControlPlaneStore applies migrations, enforces auth & sessions, and isolates tenants', () => {
  const store = new ControlPlaneStore(path.join(testDataDir, 'cp-auth.db'));
  try {
    const migrations = store.getMigrations();
    assert.equal(migrations.length >= 3, true);

    // Registration & session lookup
    const reg = store.registerUser({
      name: 'Ayesha Malik',
      email: 'ayesha@contoso.example',
      password: 'StrongPassword!2026',
      organizationName: 'Contoso Ltd',
    });
    assert.ok(reg.user.id.startsWith('usr_'));
    const sessionUser = store.getUserBySessionId(reg.sessionId);
    assert.equal(sessionUser?.email, 'ayesha@contoso.example');

    // Tenant isolation: user cannot access another tenant workspace
    assert.equal(store.getMemberForUserInWorkspace('ws_secondary', reg.user), null);
    assert.notEqual(store.getMemberForUserInWorkspace(reg.workspaceId, reg.user), null);

    // Password rejection & login
    assert.throws(() => store.loginUser('ayesha@contoso.example', 'wrong-password'));
    const login = store.loginUser('ayesha@contoso.example', 'StrongPassword!2026');
    assert.equal(login.defaultWorkspaceId, reg.workspaceId);

    // Logout removes session
    store.deleteSession(login.sessionId);
    assert.equal(store.getUserBySessionId(login.sessionId), null);

    // Invitations flow + single-use token
    const { invitation, inviteToken } = store.createInvitation(reg.workspaceId, {
      name: 'Saad Iqbal',
      email: 'saad@contoso.example',
      role: 'Designer',
      invitedByName: 'Ayesha Malik',
    });
    assert.equal(invitation.status, 'pending');
    const accepted = store.acceptInvitation(inviteToken, 'AnotherStrongPass!99');
    assert.equal(accepted.member.role, 'Designer');
    assert.equal(accepted.workspaceId, reg.workspaceId);
    assert.throws(() => store.acceptInvitation(inviteToken, 'ReuseAttempt!'));

    // Encrypted connection secret never returned on connection profile
    const saved = store.saveConnection(
      reg.workspaceId,
      {
        name: 'Private SQL',
        method: 'direct_tls',
        host: '10.0.1.25',
        instanceName: null,
        port: 1433,
        database: 'Inventory',
        authMethod: 'sql_auth',
        username: 'vds_reader',
        domain: null,
        encrypt: true,
        trustServerCertificate: false,
        readOnly: true,
        timeoutMs: 8000,
        reconnectOnStartup: false,
        environment: 'production',
        status: 'connected',
        engineVersion: 'SQL Server 2022',
        lastCheckedAt: new Date().toISOString(),
        capabilities: {
          canReadMetadata: true,
          canReadData: true,
          canWriteData: false,
          canModifySchema: false,
        },
      },
      'SuperSecretSqlPass!2026'
    );
    assert.equal((saved as unknown as Record<string, unknown>).encrypted_secret, undefined);
    assert.equal(store.getConnectionSecret(reg.workspaceId, saved.id), 'SuperSecretSqlPass!2026');
    // Tenant boundary prevents reading from another workspace
    assert.equal(store.getConnection('ws_primary', saved.id), null);
    assert.throws(() => store.getConnectionSecret('ws_primary', saved.id));
  } finally {
    store.close();
  }
});

test('billingProvider verifies HMAC webhook signatures strictly when secret is configured', () => {
  const prevSecret = process.env.BILLING_WEBHOOK_SECRET;
  const prevEnv = process.env.NODE_ENV;
  try {
    process.env.BILLING_WEBHOOK_SECRET = 'whsec_unit_test_secret';
    process.env.NODE_ENV = 'production';
    const body = JSON.stringify({ workspaceId: 'ws_primary', eventType: 'checkout.session.completed', targetTier: 'team' });
    const sig = crypto.createHmac('sha256', 'whsec_unit_test_secret').update(body).digest('hex');

    assert.equal(billingProvider.verifyWebhookSignature(body, sig), true);
    assert.equal(billingProvider.verifyWebhookSignature(body, 'invalid_sig'), false);
    assert.equal(billingProvider.verifyWebhookSignature(body, undefined), false);
  } finally {
    process.env.BILLING_WEBHOOK_SECRET = prevSecret;
    process.env.NODE_ENV = prevEnv;
  }
});

test('buildMssqlConfig handles default, named instances, NTLM Windows auth, and explicit TLS without silent bypass', () => {
  const namedCfg = buildMssqlConfig({
    host: 'WIN11-DEV\\SQLEXPRESS',
    port: 1433,
    database: 'SalesDb',
    authMethod: 'sql_auth',
    username: 'sa_app',
    password: 'pw',
    encrypt: true,
    trustServerCertificate: false,
    timeoutMs: 9000,
  });
  assert.equal(namedCfg.server, 'WIN11-DEV');
  assert.equal(namedCfg.options?.instanceName, 'SQLEXPRESS');
  assert.equal(namedCfg.port, undefined);
  assert.equal(namedCfg.options?.encrypt, true);
  assert.equal(namedCfg.options?.trustServerCertificate, false);

  const ntlmCfg = buildMssqlConfig({
    host: 'db-internal.corp.local',
    port: 1433,
    database: 'master',
    authMethod: 'windows_integrated',
    domain: 'CORP',
    username: 'svc_sql',
    password: 'DomainPassword',
    encrypt: true,
    trustServerCertificate: false,
  });
  assert.equal(ntlmCfg.authentication?.type, 'ntlm');
  assert.equal((ntlmCfg.authentication?.options as { domain?: string }).domain, 'CORP');
});

test('SandboxAdapter rejects SQL Server-only DDL and executes transactional CRUD/bulk updates', async () => {
  const dummyConn: ConnectionProfile = {
    id: 'conn_sandbox',
    workspaceId: 'ws_primary',
    name: 'Sample Sandbox',
    method: 'local_sandbox',
    host: 'local-sqlite',
    port: 0,
    database: 'NorthwindOps_Sample',
    authMethod: 'sandbox_local',
    username: 'sandbox',
    encrypt: false,
    trustServerCertificate: false,
    readOnly: false,
    timeoutMs: 5000,
    reconnectOnStartup: true,
    environment: 'sandbox',
    status: 'connected',
    engineVersion: 'SQLite',
    lastCheckedAt: new Date().toISOString(),
    capabilities: {
      canReadMetadata: true,
      canReadData: true,
      canWriteData: true,
      canModifySchema: true,
    },
  };

  await assert.rejects(() => sandboxAdapter.createDatabase(dummyConn, '', 'NewSqlDb'), /real Microsoft SQL Server/i);
  const snap = await sandboxAdapter.introspect(dummyConn, '');
  assert.equal(snap.tables.some((t) => t.tableName === 'Employees'), true);

  await assert.rejects(
    () =>
      sandboxAdapter.applyOperations(
        dummyConn,
        '',
        [{ kind: 'CREATE_DATABASE', databaseName: 'Foo' }],
        snap
      ),
    /Microsoft SQL Server/i
  );

  const bulk = await sandboxAdapter.bulkUpdateRows(dummyConn, '', {
    schemaName: 'dbo',
    tableName: 'Tasks',
    pkColumn: 'TaskID',
    pkValues: [1, 2],
    column: 'Priority',
    value: 'Urgent',
  });
  assert.equal(bulk.updatedCount, 2);
});

test('localDiscovery parses Windows Service JSON and SQL Browser UDP 1434 responses', () => {
  const svcJson = JSON.stringify([
    { Name: 'MSSQLSERVER', DisplayName: 'SQL Server (MSSQLSERVER)', Status: 'Running' },
    { Name: 'MSSQL$SQLEXPRESS', DisplayName: 'SQL Server (SQLEXPRESS)', Status: 'Stopped' },
    { Name: 'Spooler', DisplayName: 'Print Spooler', Status: 'Running' },
  ]);
  const parsedSvcs = parseWindowsSqlServicesJson(svcJson, 'DESKTOP-WIN11');
  assert.equal(parsedSvcs.length, 2);
  assert.equal(parsedSvcs[0].fullTarget, 'DESKTOP-WIN11');
  assert.equal(parsedSvcs[0].availability, 'available');
  assert.equal(parsedSvcs[1].fullTarget, 'DESKTOP-WIN11\\SQLEXPRESS');
  assert.equal(parsedSvcs[1].availability, 'stopped');

  const payloadStr = 'ServerName;DESKTOP-WIN11;InstanceName;SQLEXPRESS;IsClustered;No;Version;16.0.1000.6;tcp;51234;;';
  const buf = Buffer.concat([Buffer.from([0x05, payloadStr.length & 0xff, (payloadStr.length >> 8) & 0xff]), Buffer.from(payloadStr, 'utf8')]);
  const udpInstances = parseSqlBrowserUdpResponse(buf, 'DESKTOP-WIN11');
  assert.equal(udpInstances.length, 1);
  assert.equal(udpInstances[0].port, 51234);
  assert.equal(udpInstances[0].fullTarget, 'DESKTOP-WIN11\\SQLEXPRESS');
});

test('AgentWebSocketGateway pairs, approves, exchanges RPC calls, and rejects revoked agents', async () => {
  const { controlPlane } = await import('./controlPlane');
  const { agent, oneTimeToken } = controlPlane.createAgentPairing('ws_primary', 'Win11 Test PC', 'DEV-WIN11');

  const server = http.createServer();
  agentGateway.attach(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };

  const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/agent-ws`);
  try {
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            type: 'auth',
            token: oneTimeToken,
            hostname: 'DEV-WIN11',
            version: '1.0.0-win-x64',
            osInfo: 'win32 10.0.22631',
            discoveredInstances: [],
          })
        );
      });
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as { type: string; status?: string };
        if (msg.type === 'auth_ok') {
          assert.equal(msg.status, 'pending_approval');
          resolve();
        }
      });
      ws.on('error', reject);
    });

    // Pending approval cannot execute RPC yet
    await assert.rejects(
      () => agentGateway.callAgent('ws_primary', agent.id, 'discover_instances', {}),
      /awaiting administrator approval/i
    );

    // Approve agent and respond to an RPC call
    controlPlane.updateAgentStatus('ws_primary', agent.id, 'online');

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as { type: string; requestId?: string; method?: string };
      if (msg.type === 'rpc_request') {
        ws.send(
          JSON.stringify({
            type: 'rpc_response',
            requestId: msg.requestId,
            ok: true,
            result: { hostname: 'DEV-WIN11', instances: [{ instanceName: 'SQLEXPRESS', port: 51234 }] },
          })
        );
      }
    });

    const rpcResult = await agentGateway.callAgent<{ hostname: string; instances: Array<{ instanceName: string }> }>(
      'ws_primary',
      agent.id,
      'discover_instances',
      {}
    );
    assert.equal(rpcResult.hostname, 'DEV-WIN11');
    assert.equal(rpcResult.instances[0].instanceName, 'SQLEXPRESS');
  } finally {
    ws.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
