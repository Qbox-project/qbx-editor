import * as assert from 'node:assert/strict';
import * as dgram from 'node:dgram';
import { RconError, resourceCommand, sendRconCommand } from '../../src/rcon';

function printPacket(text: string | Buffer): Buffer {
    return Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from('print '), typeof text === 'string' ? Buffer.from(text) : text]);
}

async function withServer(body: (server: dgram.Socket, port: number) => Promise<void>, host = '127.0.0.1'): Promise<void> {
    const server = dgram.createSocket(host.includes(':') ? 'udp6' : 'udp4');
    try {
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.bind(0, host, resolve);
        });
        await body(server, server.address().port);
    } finally {
        await new Promise<void>((resolve) => {
            try { server.close(() => resolve()); } catch { resolve(); }
        });
    }
}

function errorCode(code: string): (error: unknown) => boolean {
    return (error) => error instanceof RconError && error.code === code;
}

/** Local fake servers only: these tests never contact a running FiveM instance. */
export async function runRconTests(): Promise<void> {
    assert.equal(resourceCommand('start', 'qbx_core'), 'start qbx_core');
    assert.equal(resourceCommand('stop', 'my-resource.v2'), 'stop my-resource.v2');
    assert.equal(resourceCommand('restart', '_private'), 'restart _private');
    for (const name of ['', '.', '..', '[qbx]', '../qbx_core', 'qbx/core', 'qbx\\core', 'a b', 'a;quit', 'a\nquit', 'a\0', 'a"', '*']) {
        assert.throws(() => resourceCommand('stop', name), errorCode('invalid-input'), name);
    }
    assert.throws(() => resourceCommand('quit' as 'stop', 'qbx_core'), errorCode('invalid-input'));

    await withServer(async (server, port) => {
        let received: Buffer | undefined;
        server.on('message', (packet, peer) => {
            received = packet;
            server.send(printPacket('Started resource qbx_core\n'), peer.port, peer.address);
        });
        const result = await sendRconCommand({ host: '127.0.0.1', port, password: 'secret"with\\quotes', command: resourceCommand('start', 'qbx_core'), timeoutMs: 150 });
        assert.equal(result, 'Started resource qbx_core\n');
        assert.deepEqual(received, Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from('rcon secret"with\\quotes start qbx_core')]));
    });

    await withServer(async (server, port) => {
        const intruder = dgram.createSocket('udp4');
        try {
            server.on('message', (_packet, peer) => {
                intruder.send(printPacket('wrong peer'), peer.port, peer.address);
                server.send(Buffer.from('print missing out-of-band prefix'), peer.port, peer.address);
                server.send(printPacket(Buffer.from([0x66, 0xc3])), peer.port, peer.address);
                setTimeout(() => server.send(printPacket(Buffer.from([0xa9, 0x65])), peer.port, peer.address), 25);
            });
            assert.equal(await sendRconCommand({ host: '127.0.0.1', port, password: 'secret', command: 'echo test', timeoutMs: 180 }), 'fée');
        } finally {
            intruder.close();
        }
    });

    for (const reply of ['Invalid password.\n', 'The server must set rcon_password to be able to use this command.\n']) {
        await withServer(async (server, port) => {
            server.on('message', (_packet, peer) => server.send(printPacket(reply), peer.port, peer.address));
            await assert.rejects(sendRconCommand({ host: '127.0.0.1', port, password: 'secret', command: 'echo test', timeoutMs: 200 }), errorCode('authentication'));
        });
    }

    await withServer(async (server, port) => {
        let count = 0;
        server.on('message', () => { count++; });
        await assert.rejects(sendRconCommand({ host: '127.0.0.1', port, password: 'secret', command: 'echo test', timeoutMs: 100 }), errorCode('timeout'));
        assert.equal(count, 1, 'a missing response must never cause a retry');
    });

    await withServer(async (server, port) => {
        server.on('message', (_packet, peer) => server.send(printPacket(''), peer.port, peer.address));
        assert.equal(await sendRconCommand({ host: '127.0.0.1', port, password: 'secret', command: 'echo test', timeoutMs: 100 }), '', 'empty print responses are still replies');
    });

    await withServer(async (server, port) => {
        const controller = new AbortController();
        server.on('message', () => controller.abort());
        await assert.rejects(sendRconCommand({ host: '127.0.0.1', port, password: 'secret', command: 'echo test', timeoutMs: 5000, signal: controller.signal }), errorCode('cancelled'));
        await assert.rejects(sendRconCommand({ host: '127.0.0.1', port, password: 'secret', command: 'echo test', signal: controller.signal }), errorCode('cancelled'));
    });

    for (const invalid of [
        { password: '' }, { password: 'with space' }, { password: 'with\nnewline' }, { password: 'with\0nul' },
        { command: 'start a\nquit' }, { command: 'start a; quit' }, { command: 'start a\0quit' },
        { host: 'https://localhost' }, { host: 'localhost:30120' }, { port: 0 }, { port: 65536 }, { timeoutMs: 0 },
    ]) {
        await assert.rejects(sendRconCommand({ host: '127.0.0.1', port: 30120, password: 'secret', command: 'echo test', ...invalid }), errorCode('invalid-input'));
    }

    await withServer(async (server, port) => {
        server.on('message', (_packet, peer) => server.send(printPacket('IPv6 works'), peer.port, peer.address));
        assert.equal(await sendRconCommand({ host: '[::1]', port, password: 'secret', command: 'echo test', timeoutMs: 150 }), 'IPv6 works');
    }, '::1');
}
