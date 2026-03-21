import net from "node:net";
import { env } from "../config/env.js";

function getScannerMode() {
  return env.attachmentScanEnabled ? "enabled" : "disabled";
}

function parseClamdResponse(rawResponse) {
  const text = String(rawResponse || "").trim();
  if (!text) {
    return { ok: false, status: "error", reason: "empty_response", raw: text };
  }
  if (text.includes("OK")) {
    return { ok: true, status: "clean", signature: "", raw: text };
  }
  const foundMatch = text.match(/stream:\s*(.+?)\s*FOUND/i);
  if (foundMatch) {
    return { ok: false, status: "malicious", signature: String(foundMatch[1] || "").trim(), raw: text };
  }
  return { ok: false, status: "error", reason: "unexpected_response", raw: text };
}

function scanBufferWithClamd(buffer) {
  return new Promise((resolve) => {
    const socket = net.createConnection({
      host: env.attachmentScanHost,
      port: env.attachmentScanPort,
    });
    let responseText = "";
    let settled = false;
    const timeoutMs = Math.max(1000, Number(env.attachmentScanTimeoutMs || 10000));
    const closeWith = (result) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {}
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.on("timeout", () => {
      closeWith({ ok: false, status: "error", reason: "timeout", raw: responseText });
    });
    socket.on("error", (error) => {
      closeWith({ ok: false, status: "error", reason: String(error?.message || "socket_error"), raw: responseText });
    });
    socket.on("data", (chunk) => {
      responseText += chunk.toString("utf8");
    });
    socket.on("end", () => {
      closeWith(parseClamdResponse(responseText));
    });
    socket.on("connect", () => {
      socket.write("zINSTREAM\0");
      const chunkSize = 64 * 1024;
      for (let offset = 0; offset < buffer.length; offset += chunkSize) {
        const part = buffer.subarray(offset, Math.min(offset + chunkSize, buffer.length));
        const header = Buffer.alloc(4);
        header.writeUInt32BE(part.length, 0);
        socket.write(header);
        socket.write(part);
      }
      const endHeader = Buffer.alloc(4);
      endHeader.writeUInt32BE(0, 0);
      socket.write(endHeader);
    });
  });
}

export async function scanAttachmentContentBase64(contentBase64) {
  const mode = getScannerMode();
  if (mode !== "enabled") {
    return {
      mode,
      ok: true,
      status: "not_scanned",
      signature: "",
      reason: "scanner_disabled",
      raw: "",
    };
  }
  const safeBase64 = String(contentBase64 || "").trim();
  if (!safeBase64) {
    return {
      mode,
      ok: false,
      status: "error",
      signature: "",
      reason: "missing_content",
      raw: "",
    };
  }
  let buffer;
  try {
    buffer = Buffer.from(safeBase64, "base64");
  } catch {
    return {
      mode,
      ok: false,
      status: "error",
      signature: "",
      reason: "base64_decode_failed",
      raw: "",
    };
  }
  const result = await scanBufferWithClamd(buffer);
  return {
    mode,
    ...result,
  };
}
