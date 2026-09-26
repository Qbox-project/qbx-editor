import * as dgram from 'node:dgram';
import { lookup } from 'node:dns';
import { isIP } from 'node:net';

export type ResourceAction = 'start' | 'stop' | 'restart';

export type RconErrorCode = 'invalid-input' | 'authentication' | 'timeout' | 'cancelled' | 'network' | 'response-too-large';

export class RconError extends Error {
    constructor(public readonly code: RconErrorCode, message: string) {
        super(message);
        this.name = 'RconError';
    }
}

export interface RconCommandOptions {
    host: string;
    port: number;
    password: string;
    command: string;
    /** Total DNS, connection and response collection window. Defaults to three seconds. */
    timeoutMs?: number;
    signal?: AbortSignal;
}

export function validateRconPassword(password: string): string | undefined {
    return !password || /[\s\x00-\x1f\x7f]/.test(password)
        ? 'FiveM RCON passwords cannot be empty or contain whitespace or control characters.' : undefined;
}

/** Build one exact resource operation. Categories, paths and console syntax are never accepted. */
export function resourceCommand(action: ResourceAction, resourceName: string): string {
    if (!['start', 'stop', 'restart'].includes(action)) {
        throw new RconError('invalid-input', 'Unsupported resource action.');
    }
    if (!/^[A-Za-z0-9_.-]+$/.test(resourceName) || resourceName === '.' || resourceName === '..') {
        throw new RconError('invalid-input', 'Resource names must contain only letters, numbers, underscores, hyphens or dots. Resource groups cannot be controlled together.');
    }
    return `${action} ${resourceName}`;
}

const outOfBandPrefix = Buffer.from([0xff, 0xff, 0xff, 0xff]);
const maxResponseBytes = 1024 * 1024;

/**
 * FiveM uses the Quake-style UDP out-of-band protocol, not Source RCON.
 * RconOutOfBand::Process splits its password at the first space/newline; it
 * does not remove quotation marks. Send the password verbatim without quotes.
 * https://github.com/citizenfx/fivem/blob/master/code/components/citizen-server-impl/include/outofbandhandlers/RconOutOfBand.h
 *
 * There is no request ID or end-of-response marker. Collect print packets for
 * a bounded window on a fresh, connected socket. A missing reply cannot tell
 * us whether the command ran, so never retry automatically. Replies are plain
 * server text; callers must redact secrets before displaying or logging them.
 */
export async function sendRconCommand(options: RconCommandOptions): Promise<string> {
    const { port, password, command, signal } = options;
    const timeoutMs = options.timeoutMs ?? 3000;
    const host = options.host.startsWith('[') && options.host.endsWith(']')
        ? options.host.slice(1, -1) : options.host;
    if (!host || /[\s\x00-\x1f\x7f/\\\[\]]/.test(host) || (host.includes(':') && isIP(host) !== 6)
        || (host !== options.host && isIP(host) !== 6)) {
        throw new RconError('invalid-input', 'Enter a hostname or IP address without a URL scheme or port.');
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new RconError('invalid-input', 'The RCON UDP port must be between 1 and 65535.');
    }
    const passwordError = validateRconPassword(password);
    if (passwordError) {
        throw new RconError('invalid-input', passwordError);
    }
    if (!command.trim() || /[;\x00-\x1f\x7f]/.test(command)) {
        throw new RconError('invalid-input', 'Only one console command without control characters can be sent.');
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
        throw new RconError('invalid-input', 'The RCON response timeout must be between 1 and 60000 milliseconds.');
    }
    const packet = Buffer.concat([outOfBandPrefix, Buffer.from(`rcon ${password} ${command}`, 'utf8')]);
    if (packet.length > 65507) {
        throw new RconError('invalid-input', 'The RCON request is too large for a UDP packet.');
    }
    if (signal?.aborted) {
        throw new RconError('cancelled', 'RCON request cancelled.');
    }

    return new Promise<string>((resolve, reject) => {
        let socket: dgram.Socket | undefined;
        let settled = false;
        let received = false;
        let responseBytes = 0;
        const response: Buffer[] = [];

        const finish = (error?: RconError): void => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', cancel);
            if (socket) {
                // A failed bind/connect can leave the socket already closed.
                try { socket.close(); } catch { /* Nothing remains to close. */ }
            }
            if (error) {
                reject(error);
            } else {
                resolve(Buffer.concat(response).toString('utf8').replace(/\0+$/, ''));
            }
        };
        const cancel = (): void => finish(new RconError('cancelled', 'RCON request cancelled. If it was already sent, the command may still have run.'));
        const timer = setTimeout(() => {
            finish(received ? undefined : new RconError('timeout', 'No RCON response arrived. The command may have run; it was not retried. Check the server address, UDP port, firewall and rcon_password.'));
        }, timeoutMs);
        signal?.addEventListener('abort', cancel, { once: true });

        lookup(host, (error, address, family) => {
            if (settled) {
                return;
            }
            if (error) {
                finish(new RconError('network', 'Could not resolve the RCON server hostname.'));
                return;
            }
            socket = dgram.createSocket(family === 6 ? 'udp6' : 'udp4');
            socket.on('error', () => finish(new RconError('network', 'Could not communicate with the RCON server. The command was not retried.')));
            socket.on('message', (message) => {
                if (settled || message.length < 10 || !message.subarray(0, 4).equals(outOfBandPrefix)
                    || message.subarray(4, 9).toString('ascii') !== 'print' || ![0x20, 0x0a].includes(message[9])) {
                    return;
                }
                const payload = message.subarray(10);
                const text = payload.toString('utf8').replace(/\0+$/, '').trim();
                if (/^(?:Invalid password\.|Bad rconpassword\.)$/i.test(text)) {
                    finish(new RconError('authentication', 'The server rejected the RCON password. Update the saved password in FiveM: Configure Resource Connection.'));
                    return;
                }
                if (/^(?:The server must set rcon_password to be able to use this command\.|No rconpassword set on the server\.)$/i.test(text)) {
                    finish(new RconError('authentication', 'RCON is disabled on this server. Set rcon_password in the server configuration.'));
                    return;
                }
                received = true;
                responseBytes += payload.length;
                if (responseBytes > maxResponseBytes) {
                    finish(new RconError('response-too-large', 'The RCON response exceeded 1 MiB. Check the server console for the command result.'));
                    return;
                }
                response.push(payload);
            });
            // Resolve one address and use one peer. Failing over could run a command twice.
            socket.connect(port, address, () => {
                if (!settled) {
                    socket?.send(packet, (sendError) => {
                        if (sendError) {
                            finish(new RconError('network', 'Could not send the RCON command. It was not retried.'));
                        }
                    });
                }
            });
        });
    });
}
