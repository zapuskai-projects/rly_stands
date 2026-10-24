import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyAddress, parseIpv6 } from './address-guard';
import { isLoopbackWebhookHost } from './webhook-url';

describe('разбор адресов', () => {
  it('IPv6 раскрывается целиком: сжатие, встроенный IPv4, зона', () => {
    assert.deepEqual(parseIpv6('::1'), [0, 0, 0, 0, 0, 0, 0, 1]);
    assert.deepEqual(parseIpv6('::'), [0, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(parseIpv6('[::ffff:7f00:1]'), [0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    assert.deepEqual(parseIpv6('::ffff:127.0.0.1'), [0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    assert.deepEqual(parseIpv6('fe80::1%eth0'), [0xfe80, 0, 0, 0, 0, 0, 0, 1]);
    assert.deepEqual(parseIpv6('2001:db8:0:0:0:0:0:1'), [0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]);
    for (const bad of ['1::2::3', '1:2:3:4:5:6:7', 'gggg::1', '1:2:3:4:5:6:7:8:9', '12345::1']) assert.equal(parseIpv6(bad), null, bad);
  });

  it('loopback, неопределённый и link-local адреса узнаются во всех записях', () => {
    const loop = ['127.0.0.1', '127.255.255.254', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:7f12:3456', '::7f00:1', '64:ff9b::7f00:1'];
    for (const address of loop) assert.equal(classifyAddress(address), 'LOOPBACK', address);
    for (const address of ['0.0.0.0', '0.1.2.3', '::', '0:0:0:0:0:0:0:0', '::ffff:0.0.0.0', '::ffff:0:0']) assert.equal(classifyAddress(address), 'UNSPECIFIED', address);
    for (const address of ['169.254.169.254', 'fe80::1', 'febf::1', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe']) assert.equal(classifyAddress(address), 'LINK_LOCAL', address);
  });

  it('частные сети и обычные адреса не запрещены: host.docker.internal резолвится в частный адрес', () => {
    for (const address of ['10.0.0.5', '172.17.0.1', '192.168.65.254', '128.0.0.1', '169.255.0.1', '8.8.8.8', '2001:db8::1', 'fc00::1', 'fec0::1', '::ffff:10.0.0.5', 'не адрес']) {
      assert.equal(classifyAddress(address), null, address);
    }
  });

  it('при сохранении адреса отказывают и IPv6-записи, которые ведут на сам банк', () => {
    for (const url of ['http://[::ffff:127.0.0.1]:18400/', 'http://[::ffff:7f00:1]/', 'http://[::]/', 'http://[0:0:0:0:0:0:0:1]/', 'http://[::7f00:1]/', 'http://[::ffff:0.0.0.0]/']) {
      assert.equal(isLoopbackWebhookHost(url), true, url);
    }
    for (const url of ['http://[2001:db8::1]/', 'http://[::ffff:10.0.0.5]/', 'http://[fc00::1]/']) assert.equal(isLoopbackWebhookHost(url), false, url);
  });
});
