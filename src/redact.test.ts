import test from "node:test";
import assert from "node:assert/strict";
import { redact } from "./redact.ts";

test("redact: keys, tokens, passwords in URLs and assignments go; normal text stays", () => {
  const cases: [string, string][] = [
    ["use sk-ant-api03-abcdefghijklmnopqrstuvwx now", "use [api key] now"],
    ["AKIAABCDEFGHIJKLMNOP is the key", "[aws key] is the key"],
    ["postgres://shop:S3cr3tP4ss@db.host:5432/x", "postgres://shop:[password]@db.host:5432/x"],
    ["password = hunter2hunter2", "password = [redacted]"],
    ['"api_key": "abcd1234efgh5678"', '"api_key": "[redacted]"'],
    ["Authorization: Bearer abcdefghijklmnopqrstuvwxyz", "Authorization: Bearer [token]"],
    ["token ghp_abcdefghijklmnopqrstuvwxyz0123456789 here", "token [github token] here"],
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----", "[private key]"],
  ];
  for (const [input, want] of cases) assert.equal(redact(input), want, input);
  const plain = "Fix the signer bug in e-signature; commit c5dee72db; pipeline #4083 passed on main.";
  assert.equal(redact(plain), plain, "ordinary work text is untouched (shas, numbers, names)");
});
