import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bitbucketSlug, coveringPipeline, netrcAuth, toPipeline, type Pipeline } from "./pipelines.ts";

test("bitbucketSlug: ssh and https remotes; other hosts are not Bitbucket", () => {
  assert.deepEqual(bitbucketSlug("git@bitbucket.org:datasalesio/shop.git"), { ws: "datasalesio", repo: "shop" });
  assert.deepEqual(bitbucketSlug("https://user@bitbucket.org/datasalesio/shop.git"), { ws: "datasalesio", repo: "shop" });
  assert.equal(bitbucketSlug("git@github.com:me/x.git"), null);
});

test("netrcAuth: the right machine only; missing file is no credentials", () => {
  const f = join(mkdtempSync(join(tmpdir(), "wt-netrc-")), "netrc");
  writeFileSync(f, "machine github.com login g password gp\nmachine api.bitbucket.org\n  login me@x.com\n  password s3cret\n");
  assert.equal(netrcAuth(f), "Basic " + Buffer.from("me@x.com:s3cret").toString("base64"));
  assert.equal(netrcAuth(f, "nowhere.org"), null);
  assert.equal(netrcAuth(join(tmpdir(), "does-not-exist-netrc")), null);
});

test("toPipeline: Bitbucket states to ours", () => {
  const slug = { ws: "w", repo: "r" };
  const p = (name: string, result?: string) => toPipeline({ uuid: "u", build_number: 7, created_on: "2026-10-19T10:00:00Z", target: { ref_name: "dev", commit: { hash: "abc" } }, state: { name, result: result ? { name: result } : undefined } }, slug)!;
  assert.equal(p("IN_PROGRESS").state, "running");
  assert.equal(p("COMPLETED", "SUCCESSFUL").state, "passed");
  assert.equal(p("COMPLETED", "FAILED").state, "failed");
  assert.equal(p("COMPLETED", "STOPPED").state, "stopped");
  assert.equal(p("COMPLETED", "SUCCESSFUL").url, "https://bitbucket.org/w/r/pipelines/results/7");
});

test("coveringPipeline: a commit pushed with others is covered by the first pipeline that contains it", () => {
  const mk = (n: number, commit: string, at: string): Pipeline => ({ uuid: String(n), number: n, commit, branch: "dev", state: "passed", createdAt: at, url: "" });
  const pipes = [mk(3, "tip3", "2026-10-19T12:00:00Z"), mk(2, "tip2", "2026-10-19T11:00:00Z"), mk(1, "tip1", "2026-10-19T10:00:00Z")];
  // history: c1 < tip1 < c2 < tip2 < tip3
  const order = ["c1", "tip1", "c2", "tip2", "tip3"];
  const contains = (tip: string, sha: string) => order.indexOf(sha) <= order.indexOf(tip);
  assert.equal(coveringPipeline("c2", pipes, contains)?.number, 2, "not 3: the first one that has it");
  assert.equal(coveringPipeline("tip1", pipes, contains)?.number, 1);
  assert.equal(coveringPipeline("later", pipes, () => false), null, "not pushed through a pipeline yet");
});

test("coveringPipeline: the #412 case — first pipeline with the commit failed, a later one passed: deployed in the later one", () => {
  const mk = (n: number, state: Pipeline["state"], at: string): Pipeline => ({ uuid: String(n), number: n, commit: `tip${n}`, branch: "main", state, createdAt: at, url: "" });
  const all = () => true;
  assert.equal(coveringPipeline("c", [mk(4077, "failed", "2026-10-16T19:00Z"), mk(4080, "passed", "2026-10-16T21:00Z"), mk(4090, "passed", "2026-10-17T10:00Z")], all)?.number, 4080);
  assert.deepEqual(
    (({ number, state }) => ({ number, state }))(coveringPipeline("c", [mk(1, "failed", "2026-10-16T10:00Z"), mk(2, "running", "2026-10-16T11:00Z")], all)!),
    { number: 2, state: "running" }, "nothing green yet: the latest attempt");
});

test("githubSlug: ssh and https remotes", async () => {
  const { githubSlug } = await import("./pipelines.ts");
  assert.deepEqual(githubSlug("git@github.com:jane/shop.git"), { owner: "jane", repo: "shop" });
  assert.deepEqual(githubSlug("https://github.com/jane/shop"), { owner: "jane", repo: "shop" });
  assert.equal(githubSlug("git@bitbucket.org:ws/shop.git"), null);
});

test("toGithubPipelines: one pipeline per pushed commit; green only when every workflow passed", async () => {
  const { toGithubPipelines } = await import("./pipelines.ts");
  const run = (id: number, sha: string, status: string, conclusion: string | null, branch = "main") =>
    ({ id, run_number: id, head_sha: sha, head_branch: branch, status, conclusion, created_at: `2026-10-20T10:0${id}:00Z`, html_url: `https://github.com/jane/shop/actions/runs/${id}` });
  const p = toGithubPipelines([
    run(1, "aaa", "completed", "success"), run(2, "aaa", "completed", "success"),   // tests + lint, both green
    run(3, "bbb", "completed", "success"), run(4, "bbb", "completed", "failure"),   // one workflow failed
    run(5, "ccc", "completed", "success"), run(6, "ccc", "in_progress", null),      // one still running
    run(7, "ddd", "completed", "cancelled"),
    run(8, "eee", "completed", "success", "feature-x"),                             // another branch
  ], "main");
  const by = Object.fromEntries(p.map((x) => [x.commit, x]));
  assert.equal(by.aaa.state, "passed");
  assert.equal(by.bbb.state, "failed");
  assert.equal(by.bbb.url, "https://github.com/jane/shop/actions/runs/4", "links to the workflow that failed");
  assert.equal(by.ccc.state, "running");
  assert.equal(by.ddd.state, "stopped");
  assert.equal(by.eee, undefined, "runs on other branches are not this branch's");
  assert.equal(by.aaa.number, 1);
});

test("coveringPipeline: pipelines older than the commit are never asked about; stops at the first answer", async () => {
  const { coveringPipeline } = await import("./pipelines.ts");
  const pl = (n: number, commit: string, state: "passed" | "failed", at: string) => ({ uuid: String(n), number: n, commit, branch: "main", state, createdAt: at, url: "" });
  const pipelines = [pl(1, "old", "passed", "2026-10-01T00:00:00Z"), pl(2, "t2", "failed", "2026-10-20T10:00:00Z"), pl(3, "t3", "passed", "2026-10-20T11:00:00Z"), pl(4, "t4", "passed", "2026-10-20T12:00:00Z")];
  const asked: string[] = [];
  const contains = (tip: string) => { asked.push(tip); return tip !== "old"; };
  assert.equal(coveringPipeline("c", pipelines, contains, "2026-10-20T09:30:00Z")?.number, 3, "first passing pipeline that contains it");
  assert.ok(!asked.includes("old"), "a pipeline from before the commit is skipped without git");
  assert.ok(!asked.includes("t4"), "stops at the first passing one");
});
