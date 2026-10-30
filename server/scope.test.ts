import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverLocalSessions, syncLocalSessions } from "./sync";

test("only imports exact whitelisted Pi projects and preserves source files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-scope-"));
  try {
    const project = path.join(root, "project");
    const child = path.join(project, "child");
    const neighbor = path.join(root, "project-other");
    const pi = path.join(root, ".pi", "agent", "sessions");
    const codex = path.join(root, ".codex", "sessions");
    await Promise.all([mkdir(child, { recursive: true }), mkdir(neighbor), mkdir(pi, { recursive: true }), mkdir(codex, { recursive: true })]);
    for (const [id, cwd] of [["allowed", project], ["child", child], ["neighbor", neighbor]]) {
      await writeFile(path.join(pi, `${id}.jsonl`), JSON.stringify({ type: "session", id, cwd }) + "\n");
    }
    await writeFile(path.join(codex, "same-project.jsonl"), JSON.stringify({ type: "session_meta", payload: { id: "codex", cwd: project } }) + "\n");
    const configDir = path.join(root, ".paseo", "plugin-data", "paseo-auto-sync");
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, "config.json"), JSON.stringify({ projects: [project] }));
    const imports: string[] = [];
    const result = await syncLocalSessions({
      homeDir: root,
      env: {},
      importSession: async (session) => { imports.push(session.sessionId); },
    });
    assert.deepEqual(imports, ["allowed"]);
    assert.deepEqual(result.imported, { pi: 1, codex: 0 });
    assert.deepEqual(result.deletedDangling, { pi: 0, codex: 0 });

    const all = await discoverLocalSessions({ homeDir: root, env: {}, scope: { projects: [project, child, neighbor], providers: ["pi", "codex"] } });
    assert.equal(all.sessions.length, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing or empty whitelist imports nothing; invalid settings fail closed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-scope-"));
  try {
    const pi = path.join(root, ".pi", "agent", "sessions");
    await mkdir(pi, { recursive: true });
    await writeFile(path.join(pi, "session.jsonl"), JSON.stringify({ type: "session", id: "one", cwd: root }) + "\n");
    const options = { homeDir: root, env: {} };
    assert.equal((await discoverLocalSessions(options)).sessions.length, 0);
    assert.equal((await discoverLocalSessions({ ...options, scope: { projects: [] } })).sessions.length, 0);
    assert.equal((await discoverLocalSessions({ ...options, scope: { projects: [root], providers: [] } })).sessions.length, 0);
    const configDir = path.join(root, ".paseo", "plugin-data", "paseo-auto-sync");
    await mkdir(configDir, { recursive: true });
    for (const invalid of ["{bad json", "null", JSON.stringify({ projects: ["relative"] }), JSON.stringify({ projects: [root], providers: ["unknown"] })]) {
      await writeFile(path.join(configDir, "config.json"), invalid);
      await assert.rejects(discoverLocalSessions(options));
    }
    await writeFile(path.join(configDir, "config.json"), JSON.stringify({ projects: ["~/"], providers: ["pi"] }));
    assert.equal((await discoverLocalSessions(options)).sessions.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
