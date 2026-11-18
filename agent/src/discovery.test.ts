import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSqlBrowserPacket, parseWindowsServices } from './discovery.js';

test('Windows Agent parses default and named SQL Server services cleanly', () => {
  const sample = JSON.stringify([
    { Name: 'MSSQLSERVER', DisplayName: 'SQL Server (MSSQLSERVER)', Status: 4 },
    { Name: 'MSSQL$DEV2022', DisplayName: 'SQL Server (DEV2022)', Status: 'Stopped' },
    { Name: 'SQLBrowser', DisplayName: 'SQL Server Browser', Status: 'Running' },
  ]);
  const list = parseWindowsServices(sample, 'WORKSTATION-01');
  assert.equal(list.length, 2);
  assert.equal(list[0].fullTarget, 'WORKSTATION-01');
  assert.equal(list[0].port, 1433);
  assert.equal(list[0].availability, 'available');
  assert.equal(list[1].fullTarget, 'WORKSTATION-01\\DEV2022');
  assert.equal(list[1].availability, 'stopped');
});

test('Windows Agent parses multi-instance SQL Browser UDP 1434 packet', () => {
  const text =
    'ServerName;WIN11-LAB;InstanceName;MSSQLSERVER;IsClustered;No;Version;16.0.4175.1;tcp;1433;;' +
    'ServerName;WIN11-LAB;InstanceName;SQLEXPRESS;IsClustered;No;Version;16.0.1000.6;tcp;49812;;';
  const packet = Buffer.concat([
    Buffer.from([0x05, text.length & 0xff, (text.length >> 8) & 0xff]),
    Buffer.from(text, 'utf8'),
  ]);

  const parsed = parseSqlBrowserPacket(packet, 'WIN11-LAB');
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].instanceName, 'MSSQLSERVER');
  assert.equal(parsed[0].port, 1433);
  assert.equal(parsed[1].instanceName, 'SQLEXPRESS');
  assert.equal(parsed[1].port, 49812);
});
