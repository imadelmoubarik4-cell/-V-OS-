// Minimal SMTP submission client for the booking email worker (S113): implicit
// TLS (port 465; Supabase Edge blocks 25 and 587), EHLO, AUTH PLAIN, then one
// MAIL / RCPT / DATA transaction per email over a single session. No third-party
// dependency. The connection is injected (Deno.connectTls in production, a
// scripted fake in the Node tests) and only needs read(buffer) -> n | null,
// write(bytes) -> n and close().
//
// Errors are SmtpError(code, phase): code is the 3-digit reply (null for a
// timeout or a dropped connection) and phase names the step. The server's reply
// text is never kept (it can echo an address), and the password only ever
// travels inside the AUTH line on the TLS connection.

export class SmtpError extends Error {
  constructor(code, phase) {
    super(code ? `smtp ${code} at ${phase}` : `smtp no reply at ${phase}`);
    this.name = "SmtpError";
    this.code = code;
    this.phase = phase;
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64(text) {
  let binary = "";
  for (const byte of encoder.encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// Lines starting with "." get a second "." (RFC 5321 §4.5.2); the message already
// uses CRLF line ends.
export function dotStuff(data) {
  return data.replace(/(^|\r\n)\./g, "$1..");
}

export function createSmtpClient({ connect, timeoutMs = 20_000, heloName = "kanel.is" }) {
  async function open({ host, port, user, password }) {
    let conn;
    try {
      conn = await connect({ hostname: host, port });
    } catch {
      throw new SmtpError(null, "connect");
    }
    let pending = "";
    const buffer = new Uint8Array(4096);

    function withTimeout(promise, phase) {
      let timer;
      return Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            try { conn.close(); } catch { /* already closed */ }
            reject(new SmtpError(null, phase));
          }, timeoutMs);
        }),
      ]).finally(() => clearTimeout(timer));
    }

    // One complete reply: the last line is "NNN " (or just "NNN").
    async function reply(phase) {
      for (;;) {
        const lines = pending.split("\r\n");
        for (let index = 0; index < lines.length - 1; index += 1) {
          const match = /^(\d{3})(?: |$)/.exec(lines[index]);
          if (match) {
            pending = lines.slice(index + 1).join("\r\n");
            return Number(match[1]);
          }
        }
        let n;
        try {
          n = await withTimeout(conn.read(buffer), phase);
        } catch (error) {
          if (error instanceof SmtpError) throw error;
          throw new SmtpError(null, phase);
        }
        if (n === null || n === 0) throw new SmtpError(null, phase);
        pending += decoder.decode(buffer.subarray(0, n), { stream: true });
      }
    }

    async function write(text, phase) {
      const bytes = encoder.encode(text);
      let offset = 0;
      try {
        while (offset < bytes.length) offset += await withTimeout(conn.write(bytes.subarray(offset)), phase);
      } catch (error) {
        if (error instanceof SmtpError) throw error;
        throw new SmtpError(null, phase);
      }
    }

    async function command(line, accept, phase) {
      await write(`${line}\r\n`, phase);
      const code = await reply(phase);
      if (!accept.includes(code)) throw new SmtpError(code, phase);
      return code;
    }

    try {
      const greeting = await reply("greeting");
      if (greeting !== 220) throw new SmtpError(greeting, "greeting");
      await command(`EHLO ${heloName}`, [250], "ehlo");
      await command(`AUTH PLAIN ${base64(`\u0000${user}\u0000${password}`)}`, [235], "auth");
    } catch (error) {
      try { conn.close(); } catch { /* already closed */ }
      throw error;
    }

    async function send({ from, to, data }) {
      try {
        await command(`MAIL FROM:<${from}>`, [250], "mail");
        await command(`RCPT TO:<${to}>`, [250, 251], "rcpt");
        await command("DATA", [354], "data");
      } catch (error) {
        // The transaction never reached the message: reset it so the session can
        // carry the next email. A dead connection fails the reset too.
        if (error.code) await command("RSET", [250], "rset").catch(() => {});
        throw error;
      }
      // From here a missing reply is uncertain: the server may have accepted it.
      await write(`${dotStuff(data)}\r\n.\r\n`, "data-end");
      const code = await reply("data-end");
      if (code !== 250) throw new SmtpError(code, "data-end");
    }

    async function quit() {
      try { await command("QUIT", [221], "quit"); } catch { /* best effort */ }
      try { conn.close(); } catch { /* already closed */ }
    }

    return { send, quit };
  }

  return { open };
}
