import assert from "node:assert/strict";
import { sanitizeOutbound, DEFAULT_MAX_BYTES } from "../src/sanitize.mjs";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

// 密钥夹具一律运行时拼接：净化闸门的单测必须喂入完整密钥形状，
// 但版本库里不该出现这类字面量（否则任何密钥扫描器都会拦下本文件）。
const pemHead = (label) => `-----BEGIN ${label}-----`;
const pemTail = (label) => `-----END ${label}-----`;
const pemBlock = (label, body) => [pemHead(label), body, pemTail(label)].join("\n");
const fakeSk = () => "sk-" + "abcdefghijklmnopqrstuvwxyz123456";
const fakeBearer = () => "abcdefghijklmnopqrstuvwxyz123456";

test("私钥块整段拒绝", () => {
  const pem = pemBlock("RSA PRIVATE KEY", "MIIEowIBAAKCAQEA1234");
  const r = sanitizeOutbound(`帮我看看\n${pem}\n完了`);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "SENSITIVE_BLOCKED");
});

test("私钥块即使 --allow-sensitive 也拒绝", () => {
  const pem = pemBlock(
    "OPENSSH PRIVATE KEY",
    "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZWQyNTUxOQ",
  );
  const r = sanitizeOutbound(pem, { allowSensitive: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "SENSITIVE_BLOCKED");
});

test("带传统头行的加密 PEM 被拒绝（Proc-Type / DEK-Info）", () => {
  const pem = [
    pemHead("RSA PRIVATE KEY"),
    "Proc-Type: 4,ENCRYPTED",
    "DEK-Info: AES-128-CBC,1234567890ABCDEF",
    "",
    "MIIEowIBAAKCAQEA1234",
    pemTail("RSA PRIVATE KEY"),
  ].join("\n");
  const r = sanitizeOutbound(`看看这个：\n${pem}`);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "SENSITIVE_BLOCKED");
});

test("JSON 字符串里换行是字面 \\n 的私钥也被拒绝", () => {
  const jsonEscaped = JSON.stringify({
    key: pemBlock("PRIVATE KEY", "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ"),
  });
  const r = sanitizeOutbound(jsonEscaped);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "SENSITIVE_BLOCKED");
});

test("非标准标签（SSH2 / X9.42 DH）也被拒绝", () => {
  const a = pemBlock("SSH2 ENCRYPTED PRIVATE KEY", "MIIEowIBAAKCAQEA1234567890abcdef");
  const b = pemBlock("X9.42 DH PRIVATE KEY", "MIIEowIBAAKCAQEA1234567890abcdef");
  assert.equal(sanitizeOutbound(a).ok, false);
  assert.equal(sanitizeOutbound(b).ok, false);
});

test("--allow-sensitive 时会报告检测到的敏感类型", () => {
  const r = sanitizeOutbound(`key=${fakeSk()} 和 JWT eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdef`, {
    allowSensitive: true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.warnings.length, 1);
  assert.ok(r.warnings[0].includes("api-key"));
  assert.ok(r.warnings[0].includes("jwt"));
});

test("sk- 形状密钥被脱敏", () => {
  const r = sanitizeOutbound(`我的 key 是 ${fakeSk()} 谢谢`);
  assert.equal(r.ok, true);
  assert.ok(!r.text.includes(fakeSk()));
  assert.ok(r.text.includes("[REDACTED_KEY]"));
  assert.deepEqual(r.redactions, ["secrets"]);
});

test("Windows 家目录路径被脱敏", () => {
  const input = "路径 C:\\Users\\12017\\project\\src\\a.ts 是哪个";
  const r = sanitizeOutbound(input);
  assert.equal(r.ok, true);
  assert.equal(r.text.includes("12017"), false);
  assert.ok(r.text.includes("C:\\Users\\[user]"));
  assert.ok(r.text.includes("\\project\\src\\a.ts"));
});

test("macOS / Linux 家目录路径被脱敏", () => {
  const r1 = sanitizeOutbound("见 /Users/alice/dev/x.ts");
  assert.ok(r1.text.includes("/Users/[user]/dev/x.ts"));
  const r2 = sanitizeOutbound("见 /home/bob/dev/x.ts");
  assert.ok(r2.text.includes("/home/[user]/dev/x.ts"));
});

test("超长 prompt 拒绝，--allow-large 放宽", () => {
  const big = "x".repeat(DEFAULT_MAX_BYTES + 10);
  const r = sanitizeOutbound(big);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "PAYLOAD_TOO_LARGE");
  const r2 = sanitizeOutbound(big, { allowLarge: true });
  assert.equal(r2.ok, true);
});

test("包含 PEM 正则的源码不被误判（回归）", () => {
  const source =
    'const PATTERNS = [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----/];';
  const r = sanitizeOutbound(`请审查这段代码：\n${source}`);
  assert.equal(r.ok, true);
});

test("空 prompt 拒绝", () => {
  const r = sanitizeOutbound("   ");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "INVALID_ARGUMENTS");
});

test("--allow-sensitive 放行普通内容但记录警告", () => {
  const r = sanitizeOutbound(`普通内容 ${fakeSk()}`, { allowSensitive: true });
  assert.equal(r.ok, true);
  assert.ok(r.text.includes(fakeSk()));
  assert.equal(r.warnings.length, 1);
});

test("Bearer token 脱敏", () => {
  const r = sanitizeOutbound(`Authorization: Bearer ${fakeBearer()}`);
  assert.ok(!r.text.includes(fakeBearer()));
});

let failed = 0;
for (const { name, fn } of cases) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`✗ ${name}\n  ${error.message}`);
  }
}
console.log(`\nsanitize: ${cases.length - failed}/${cases.length} passed`);
process.exitCode = failed ? 1 : 0;
