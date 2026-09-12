import { redact } from "./logger.mjs";

export const DEFAULT_MAX_BYTES = 50 * 1024;
export const HARD_MAX_BYTES = 200 * 1024;

/**
 * PEM/PGP 私钥检测。
 * 标签放宽到 [A-Z0-9 .-]（覆盖 OPENSSH / SSH2 ENCRYPTED / X9.42 DH / PGP BLOCK…），
 * 但正文必须「有长 base64 段」或「有典型头行」——否则「包含 PEM 正则的源码」会被误判。
 * 同时检查原文与 JSON 反转义后的文本（密钥从 JSON 里复制出来时换行是字面 \n）。
 */
const PEM_BLOCK_RE = new RegExp(
  "-----BEGIN ([A-Z0-9 .\\-]*PRIVATE KEY(?: BLOCK)?)-----([\\s\\S]*?)-----END \\1-----",
  "g"
);
const BODY_LOOKS_LIKE_KEY = /(?:[A-Za-z0-9+/=]{16,})|(?:Proc-Type\s*:|DEK-Info\s*:|Version\s*:\s*GnuPG|OpenSSH|SSH2)/;

export function findPrivateKeyBlock(text) {
  if (typeof text !== "string" || !text.includes("PRIVATE KEY")) return null;
  const candidates = [text, text.replace(/\\r\\n|\\n|\\r/g, "\n")];
  for (const candidate of candidates) {
    PEM_BLOCK_RE.lastIndex = 0;
    let match;
    while ((match = PEM_BLOCK_RE.exec(candidate)) !== null) {
      if (BODY_LOOKS_LIKE_KEY.test(match[2] ?? "")) return match[0].slice(0, 72);
    }
  }
  return null;
}

const HOME_PATHS = [
  [/\b[A-Za-z]:\\Users\\[^\\\s"'`]+/g, "C:\\Users\\[user]"],
  [/\/Users\/[^/\s"'`]+/g, "/Users/[user]"],
  [/\/home\/[^/\s"'`]+/g, "/home/[user]"],
];

/** 只做检测、不改写：用于 --allow-sensitive 时告知用户「放行了什么」。 */
const SENSITIVE_HINTS = [
  [/\b(sk|rk)-[A-Za-z0-9_-]{12,}/g, "api-key"],
  [/\bghp_[A-Za-z0-9]{12,}/g, "github-token"],
  [/\bgithub_pat_[A-Za-z0-9_]{12,}/g, "github-token"],
  [/\bxox[baprs]-[A-Za-z0-9-]{8,}/g, "slack-token"],
  [/\bAKIA[0-9A-Z]{12,}/g, "aws-key"],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, "google-key"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/g, "jwt"],
  [/\b[A-Za-z]:\\Users\\[^\\\s"'`]+/g, "home-path"],
  [/\/Users\/[^/\s"'`]+/g, "home-path"],
  [/\/home\/[^/\s"'`]+/g, "home-path"],
];

export function detectSensitive(text) {
  if (typeof text !== "string") return [];
  const kinds = new Set();
  for (const [re, kind] of SENSITIVE_HINTS) {
    re.lastIndex = 0;
    if (re.test(text)) kinds.add(kind);
  }
  return [...kinds];
}

/**
 * 发送前确定性闸门（裁决者）。
 * @returns {{ok:true, text:string, redactions:string[], warnings:string[]} | {ok:false, reason:string, message:string}}
 */
export function sanitizeOutbound(text, { allowSensitive = false, allowLarge = false, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (typeof text !== "string" || text.trim() === "") {
    return { ok: false, reason: "INVALID_ARGUMENTS", message: "prompt 为空" };
  }
  const bytes = Buffer.byteLength(text, "utf8");
  const cap = allowLarge ? HARD_MAX_BYTES : maxBytes;
  if (bytes > cap) {
    return {
      ok: false,
      reason: "PAYLOAD_TOO_LARGE",
      message: `prompt 约 ${bytes} 字节，超过上限 ${cap} 字节；请先摘要或分片（--allow-large 可放宽到 ${HARD_MAX_BYTES}）。`,
    };
  }

  // 私钥块：无条件拒绝（即使 --allow-sensitive）
  if (findPrivateKeyBlock(text)) {
    return {
      ok: false,
      reason: "SENSITIVE_BLOCKED",
      message: "内容包含私钥块（PEM/PGP），已拒绝发送；请移除或改为摘要后再试。",
    };
  }

  const found = detectSensitive(text);

  if (allowSensitive) {
    return {
      ok: true,
      text,
      redactions: [],
      warnings: [
        found.length
          ? `allow-sensitive：检测到 ${found.join(" / ")}，已按用户同意原样发送`
          : "allow-sensitive：脱敏已按用户同意关闭",
      ],
    };
  }

  let out = text;
  const redactions = [];
  const before = out;
  out = redact(out);
  if (out !== before) redactions.push("secrets");

  for (const [re, rep] of HOME_PATHS) {
    const prev = out;
    out = out.replace(re, rep);
    if (out !== prev && !redactions.includes("home-paths")) redactions.push("home-paths");
  }

  return { ok: true, text: out, redactions, warnings: [] };
}
