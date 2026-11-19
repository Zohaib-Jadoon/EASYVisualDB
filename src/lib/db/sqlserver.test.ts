import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  SqlServerConnectionParams,
  SqlServerCredentialsConfig,
  SqlServerInstanceMetadata,
} from '../../shared/types';
import {
  BaseSqlServerAdapter,
  buildSqlServerConfig,
  classifySqlServerError,
  inspectWindowsIntegratedDriverSupport,
  SqlServerAdapter,
  sqlServerAdapter,
} from './sqlserver';

test('Shared SQL Server connection params, Windows Auth placeholders, and instance metadata types align cleanly', () => {
  const winParams: SqlServerConnectionParams = {
    connectionName: 'Local Express',
    method: 'direct_tls',
    host: 'WORKSTATION01',
    instanceName: 'SQLEXPRESS',
    port: 1433,
    database: 'InventoryDB',
    authMethod: 'windows_integrated',
    username: 'CORP\\jdoe',
    password: 'Secret!',
    domain: 'CORP',
    windowsAuth: {
      mode: 'ntlm_credentials',
      domain: 'CORP',
      useCurrentWindowsIdentity: false,
    },
    encrypt: true,
    trustServerCertificate: true,
    readOnly: true,
  };

  const creds: SqlServerCredentialsConfig = {
    authMethod: 'windows_integrated',
    username: winParams.username,
    password: winParams.password,
    domain: winParams.domain,
    windowsAuth: winParams.windowsAuth,
  };

  const meta: SqlServerInstanceMetadata = {
    serverName: 'WORKSTATION01',
    instanceName: 'SQLEXPRESS',
    fullTarget: 'WORKSTATION01\\SQLEXPRESS',
    port: null,
    version: '16.0.1000.6',
    edition: 'Express Edition',
    serviceStatus: 'Running',
    availability: 'available',
    isDefaultInstance: false,
    isLocalHost: true,
    source: 'windows_service',
    windowsAuthSupport: inspectWindowsIntegratedDriverSupport(),
  };

  const cfg = buildSqlServerConfig(winParams);
  assert.equal(cfg.authentication?.type, 'ntlm');
  assert.equal(creds.windowsAuth?.mode, 'ntlm_credentials');
  assert.equal(meta.fullTarget, 'WORKSTATION01\\SQLEXPRESS');
});

test('SqlServerAdapter extends BaseSqlServerAdapter and exposes SQL Server interface methods', async () => {
  const adapter: SqlServerAdapter = new SqlServerAdapter();
  assert.equal(adapter instanceof BaseSqlServerAdapter, true);
  assert.equal(adapter.kind, 'sql_server_direct');
  assert.equal(sqlServerAdapter.kind, 'sql_server_direct');
  assert.equal(typeof adapter.testConnection, 'function');
  assert.equal(typeof adapter.listDatabases, 'function');
  assert.equal(typeof adapter.getSchema, 'function');
  assert.equal(typeof adapter.executeQuery, 'function');

  const blocked = await adapter.testConnection({
    host: '169.254.169.254',
    port: 1433,
    database: 'master',
    authMethod: 'sql_auth',
    username: 'sa',
    password: 'Secret!',
    encrypt: true,
    trustServerCertificate: false,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.steps[0]?.status, 'failed');
  assert.match(blocked.steps[0]?.detail || '', /Blocked destination address/i);
});

test('buildSqlServerConfig handles default instance, named instance, and preserves TLS trust flag without silent override', () => {
  const defCfg = buildSqlServerConfig({
    host: 'db.company.local',
    port: 1433,
    database: 'SalesDB',
    authMethod: 'sql_auth',
    username: 'sa',
    password: 'StrongPassword!',
    encrypt: true,
    trustServerCertificate: false,
    timeoutMs: 12000,
  });

  assert.equal(defCfg.server, 'db.company.local');
  assert.equal(defCfg.port, 1433);
  assert.equal(defCfg.database, 'SalesDB');
  assert.equal(defCfg.options?.encrypt, true);
  assert.equal(defCfg.options?.trustServerCertificate, false);
  assert.equal(defCfg.options?.instanceName, undefined);

  const namedCfg = buildSqlServerConfig({
    host: 'WORKSTATION01\\SQLEXPRESS',
    port: 1433,
    database: 'master',
    authMethod: 'sql_auth',
    username: 'app_user',
    password: 'Secret!',
    encrypt: true,
    trustServerCertificate: true,
  });

  assert.equal(namedCfg.server, 'WORKSTATION01');
  assert.equal(namedCfg.options?.instanceName, 'SQLEXPRESS');
  assert.equal(namedCfg.port, undefined);
});

test('buildSqlServerConfig builds NTLM auth when domain\\user and password are provided', () => {
  const ntlmCfg = buildSqlServerConfig({
    host: 'sql-intranet.corp',
    port: 1433,
    database: 'Finance',
    authMethod: 'windows_integrated',
    username: 'CORP\\analyst',
    password: 'DomainPassword!',
    encrypt: true,
    trustServerCertificate: false,
  });

  assert.equal(ntlmCfg.authentication?.type, 'ntlm');
  assert.deepEqual(ntlmCfg.authentication?.options, {
    domain: 'CORP',
    userName: 'analyst',
    password: 'DomainPassword!',
  });
});

test('buildSqlServerConfig refuses silent fallback when passwordless Windows SSPI is requested without driver', () => {
  assert.throws(
    () =>
      buildSqlServerConfig({
        host: 'localhost',
        port: 1433,
        database: 'master',
        authMethod: 'windows_integrated',
        username: '',
        password: '',
        encrypt: true,
        trustServerCertificate: true,
      }),
    /Passwordless Windows Integrated Security|Native SSPI/i
  );
});

test('inspectWindowsIntegratedDriverSupport honestly reports platform driver availability', () => {
  const status = inspectWindowsIntegratedDriverSupport();
  assert.equal(status.platform, process.platform);
  if (process.platform !== 'win32') {
    assert.equal(status.nativeSspiAvailable, false);
    assert.equal(status.driverName, 'tedious-ntlm-only');
  }
  assert.ok(status.detail.length > 20);
});

test('classifySqlServerError maps connection and security errors accurately', () => {
  assert.equal(
    classifySqlServerError(new Error('getaddrinfo ENOTFOUND missing.local')).category,
    'host_not_found'
  );
  assert.equal(
    classifySqlServerError(new Error('connect ECONNREFUSED 127.0.0.1:1433')).category,
    'service_unavailable'
  );
  assert.equal(
    classifySqlServerError(new Error('connect ENETUNREACH 10.0.0.5:1433')).category,
    'network_unreachable'
  );
  assert.equal(
    classifySqlServerError(new Error('self signed certificate in certificate chain')).category,
    'tls_certificate_failed'
  );
  assert.equal(
    classifySqlServerError(new Error('Login failed for user sa (Error 18456)'), 'sql_auth').category,
    'authentication_failed'
  );
  assert.equal(
    classifySqlServerError(new Error('SELECT permission denied on object Users (229)')).category,
    'insufficient_permissions'
  );
  assert.equal(
    classifySqlServerError(new Error('Connection timeout expired')).category,
    'connection_timeout'
  );
  assert.equal(
    classifySqlServerError(new Error('Failed to resolve instance SQLEXPRESS on UDP 1434')).category,
    'named_instance_resolution_failed'
  );
});
