import { execFile } from "node:child_process";
import { constants, createReadStream } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const JSONL_EXTENSION = ".jsonl";
const AUTO_SYNC_LABEL = "paseo-auto-sync=true";
const IMPORT_TIMEOUT_MS = 120_000;
const DEFAULT_IMPORT_BATCH_SIZE = 50;
const MAX_IMPORT_BATCH_SIZE = 50;
const DEFAULT_SYNC_INTERVAL_SECONDS = 30;
const MAX_SYNC_INTERVAL_SECONDS = 86400;

// Codex rollout 文件名以 session UUID 结尾；首行损坏时仍可据此确认原生会话存在。
const CODEX_SESSION_ID_SUFFIX =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu;

// 匹配 Pi 的分支会话和子任务会话，它们不是会话列表中的主会话。
const PI_INTERNAL_SESSION_PATH =
  /(?:^|[\\/])forks[\\/]|[\\/]run-\d+[\\/]session\.jsonl$/u;

type Provider = "codex" | "pi";

export interface LocalSession {
  provider: Provider;
  providerHandleId: string;
  sessionId: string;
  cwd: string;
  sourcePath: string;
  modifiedAt: number;
  title?: string;
}

export interface DiscoveryResult {
  sessions: LocalSession[];
  skippedInvalid: Record<Provider, number>;
  existingKeys: Set<string>;
}

export interface SyncResult {
  discovered: Record<Provider, number>;
  imported: Record<Provider, number>;
  skippedRegistered: Record<Provider, number>;
  skippedInvalid: Record<Provider, number>;
  deferred: Record<Provider, number>;
  remaining: Record<Provider, number>;
  failed: Record<Provider, number>;
  deletedDangling: Record<Provider, number>;
  skippedRunningDangling: Record<Provider, number>;
  cleanupFailed: Record<Provider, number>;
  archivedEmptyWorkspaces: number;
  workspaceArchiveFailed: number;
}

export interface SyncScope {
  projects: string[];
  providers?: Provider[];
}

interface SyncOptions {
  scope?: SyncScope;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  signal?: AbortSignal;
  batchSize?: number;
  importSession?: (
    session: LocalSession,
    signal?: AbortSignal,
  ) => Promise<void>;
}

interface SessionSyncController {
  trigger(): { status: "started" | "running" };
  dispose(): void;
}

/**
 * 创建带 single-flight 保护的同步控制器，合并多个 Paseo 窗口的并发触发。
 *
 * @returns 可触发同步和取消后台任务的控制器。
 */
export function createSessionSyncController(): SessionSyncController {
  let activeSync: Promise<void> | null = null;
  let abortController: AbortController | null = null;

  const trigger = () => {
    if (activeSync) {
      return { status: "running" } as const;
    }

    abortController = new AbortController();
    activeSync = syncLocalSessions({ signal: abortController.signal })
      .then((result) => {
        console.info("[paseo-auto-sync] Sync completed", result);
      })
      .catch((error: unknown) => {
        if (!abortController?.signal.aborted) {
          console.error("[paseo-auto-sync] Sync failed", error);
        }
      })
      .finally(() => {
        activeSync = null;
        abortController = null;
      });

    return { status: "started" } as const;
  };
  const timer = setInterval(
    trigger,
    resolveSyncIntervalMs(process.env.PASEO_AUTO_SYNC_INTERVAL_SECONDS),
  );
  timer.unref();

  return {
    trigger,
    dispose() {
      clearInterval(timer);
      abortController?.abort();
    },
  };
}

/**
 * 扫描本机 Codex 与 Pi 主会话，并返回可用于 Paseo import 的原生句柄。
 *
 * @param options 可选的环境变量与主目录覆盖，主要用于测试和自定义安装路径。
 * @returns 会话列表以及因格式或目录无效而跳过的数量。
 */
export async function discoverLocalSessions(
  options: SyncOptions = {},
): Promise<DiscoveryResult> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const codexHome = resolveConfiguredPath(
    env.CODEX_HOME,
    path.join(homeDir, ".codex"),
    homeDir,
  );
  const piAgentDir = resolveConfiguredPath(
    env.PI_CODING_AGENT_DIR,
    path.join(homeDir, ".pi", "agent"),
    homeDir,
  );
  const piSessionsDir = resolveConfiguredPath(
    env.PI_CODING_AGENT_SESSION_DIR,
    path.join(piAgentDir, "sessions"),
    homeDir,
  );

  const scope = validateScope(
    options.scope ?? (await readSyncScope(env, homeDir)),
    homeDir,
  );
  // Missing or empty project configuration is fail-closed: import nothing.
  if (scope.projects.length === 0) {
    return {
      sessions: [],
      skippedInvalid: { codex: 0, pi: 0 },
      existingKeys: new Set(),
    };
  }
  const empty = () => ({
    sessions: [] as LocalSession[],
    skippedInvalid: 0,
    existingKeys: new Set<string>(),
  });
  const [codexLive, codexArchived, pi] = await Promise.all([
    scope.providers.includes("codex")
      ? discoverCodexSessions(path.join(codexHome, "sessions"), options.signal)
      : empty(),
    scope.providers.includes("codex")
      ? discoverCodexSessions(
          path.join(codexHome, "archived_sessions"),
          options.signal,
        )
      : empty(),
    scope.providers.includes("pi")
      ? discoverPiSessions(piSessionsDir, options.signal)
      : empty(),
  ]);

  const sessionsByKey = new Map<string, LocalSession>();
  for (const session of [
    ...codexLive.sessions,
    ...codexArchived.sessions,
    ...pi.sessions,
  ]) {
    if (!scope.projects.includes(path.resolve(session.cwd))) {
      continue;
    }
    const key = sessionKey(session.provider, session.providerHandleId);
    const current = sessionsByKey.get(key);
    if (!current || current.modifiedAt < session.modifiedAt) {
      sessionsByKey.set(key, session);
    }
  }

  const existingKeys = new Set<string>([
    ...codexLive.existingKeys,
    ...codexArchived.existingKeys,
    ...pi.existingKeys,
  ]);

  return {
    sessions: [...sessionsByKey.values()].sort(
      (left, right) => right.modifiedAt - left.modifiedAt,
    ),
    skippedInvalid: {
      codex: codexLive.skippedInvalid + codexArchived.skippedInvalid,
      pi: pi.skippedInvalid,
    },
    existingKeys,
  };
}

/** Read active and archived native handles without modifying Paseo records. */
export async function readRegisteredSessionKeys(
  paseoHome: string,
): Promise<Set<string>> {
  const agentFiles = await walkFiles(path.join(paseoHome, "agents"), ".json");
  const keys = new Set<string>();

  await Promise.all(
    agentFiles.map(async (file) => {
      try {
        const record = JSON.parse(await readFile(file, "utf8")) as {
          persistence?: {
            provider?: unknown;
            sessionId?: unknown;
            nativeHandle?: unknown;
          } | null;
        };
        const provider = record.persistence?.provider;
        if (provider !== "codex" && provider !== "pi") {
          return;
        }
        const sessionId =
          typeof record.persistence?.sessionId === "string"
            ? record.persistence.sessionId
            : undefined;
        const nativeHandle =
          typeof record.persistence?.nativeHandle === "string"
            ? record.persistence.nativeHandle
            : undefined;
        if (sessionId) {
          keys.add(sessionKey(provider, sessionId));
        }
        if (nativeHandle) {
          keys.add(sessionKey(provider, nativeHandle));
        }
      } catch {
        // 单个损坏记录不应触发删除，也不应阻断其他会话同步。
      }
    }),
  );

  return keys;
}

/**
 * 将尚未登记的本机主会话逐个导入 Paseo，并继续处理单个失败项。
 *
 * @param options 环境、取消信号和测试用导入函数覆盖。
 * @returns 各 provider 的发现、导入、跳过和失败计数。
 */
export async function syncLocalSessions(
  options: SyncOptions = {},
): Promise<SyncResult> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const paseoHome = resolveConfiguredPath(
    env.PASEO_HOME,
    path.join(homeDir, ".paseo"),
    homeDir,
  );
  const [discovery, registered] = await Promise.all([
    discoverLocalSessions({ ...options, env, homeDir }),
    readRegisteredSessionKeys(paseoHome),
  ]);
  const importSession = options.importSession ?? importWithPaseoCli;
  const result = createEmptyResult(discovery.skippedInvalid);
  const batchSize = resolveBatchSize(
    options.batchSize,
    env.PASEO_AUTO_SYNC_BATCH_SIZE,
  );
  let attemptedImports = 0;

  // This fork is import-only. Missing native files never delete or archive
  // existing Paseo agents/workspaces, including records outside the scope.

  for (const session of discovery.sessions) {
    throwIfAborted(options.signal);
    result.discovered[session.provider] += 1;

    const handleKey = sessionKey(session.provider, session.providerHandleId);
    const idKey = sessionKey(session.provider, session.sessionId);
    if (registered.has(handleKey) || registered.has(idKey)) {
      result.skippedRegistered[session.provider] += 1;
      continue;
    }

    if (attemptedImports >= batchSize) {
      result.remaining[session.provider] += 1;
      continue;
    }

    attemptedImports += 1;
    try {
      await importSession(session, options.signal);
      registered.add(handleKey);
      registered.add(idKey);
      result.imported[session.provider] += 1;
    } catch (error: unknown) {
      if (options.signal?.aborted) {
        throw error;
      }
      if (isAlreadyImportedError(error)) {
        registered.add(handleKey);
        registered.add(idKey);
        result.skippedRegistered[session.provider] += 1;
        continue;
      }
      if (isActiveWriterError(error)) {
        result.deferred[session.provider] += 1;
        console.info(
          `[paseo-auto-sync] Deferred ${session.provider} session ${session.sessionId}: active writer`,
        );
        continue;
      }
      result.failed[session.provider] += 1;
      console.error(
        `[paseo-auto-sync] Failed to import ${session.provider} session ${session.sessionId}: ${errorMessage(error)}`,
      );
    }
  }

  return result;
}

async function discoverCodexSessions(root: string, signal?: AbortSignal) {
  const files = await walkFiles(root, JSONL_EXTENSION);
  const sessions: LocalSession[] = [];
  const existingKeys = new Set<string>();
  let skippedInvalid = 0;

  for (const file of files) {
    throwIfAborted(signal);
    const filenameSessionId = path.basename(file).match(
      CODEX_SESSION_ID_SUFFIX,
    )?.[1];
    if (filenameSessionId) {
      existingKeys.add(sessionKey("codex", filenameSessionId));
    }
    try {
      const firstLine = await readFirstLine(file);
      const parsed = JSON.parse(firstLine) as {
        type?: unknown;
        payload?: {
          session_id?: unknown;
          id?: unknown;
          cwd?: unknown;
          source?: unknown;
          originator?: unknown;
        };
      };
      const sessionId = parsed.payload?.session_id ?? parsed.payload?.id;
      const source = parsed.payload?.source;
      const originator = parsed.payload?.originator;
      if (typeof sessionId === "string") {
        existingKeys.add(sessionKey("codex", sessionId));
      }

      // exec 与 subagent 是一次性内部任务，导入后只会污染用户的主会话列表。
      if (
        parsed.type !== "session_meta" ||
        source === "exec" ||
        (source !== null && typeof source === "object") ||
        originator === "codex_exec" ||
        typeof sessionId !== "string" ||
        typeof parsed.payload?.cwd !== "string" ||
        !(await isDirectory(parsed.payload.cwd))
      ) {
        skippedInvalid += 1;
        continue;
      }

      sessions.push({
        provider: "codex",
        providerHandleId: sessionId,
        sessionId,
        cwd: parsed.payload.cwd,
        sourcePath: file,
        modifiedAt: (await stat(file)).mtimeMs,
      });
    } catch {
      skippedInvalid += 1;
    }
  }

  return { sessions, skippedInvalid, existingKeys };
}

async function discoverPiSessions(root: string, signal?: AbortSignal) {
  const files = await walkFiles(root, JSONL_EXTENSION);
  const sessions: LocalSession[] = [];
  const existingKeys = new Set<string>();
  let skippedInvalid = 0;

  for (const file of files) {
    throwIfAborted(signal);
    existingKeys.add(sessionKey("pi", path.resolve(file)));
    if (PI_INTERNAL_SESSION_PATH.test(file)) {
      skippedInvalid += 1;
      continue;
    }

    try {
      const parsed = JSON.parse(await readFirstLine(file)) as {
        type?: unknown;
        id?: unknown;
        cwd?: unknown;
      };
      if (typeof parsed.id === "string") {
        existingKeys.add(sessionKey("pi", parsed.id));
      }
      if (
        parsed.type !== "session" ||
        typeof parsed.id !== "string" ||
        typeof parsed.cwd !== "string" ||
        !(await isDirectory(parsed.cwd))
      ) {
        skippedInvalid += 1;
        continue;
      }

      sessions.push({
        provider: "pi",
        providerHandleId: path.resolve(file),
        sessionId: parsed.id,
        cwd: parsed.cwd,
        sourcePath: file,
        modifiedAt: (await stat(file)).mtimeMs,
      });
    } catch {
      skippedInvalid += 1;
    }
  }

  return { sessions, skippedInvalid, existingKeys };
}

async function importWithPaseoCli(
  session: LocalSession,
  signal?: AbortSignal,
): Promise<void> {
  const paseo = await findPaseoCli();
  const title = workspaceTitle(session);
  const created = await execJson(
    paseo,
    [
      "workspace",
      "create",
      "--isolation",
      "local",
      "--path",
      session.cwd,
      "--title",
      title,
      "--json",
    ],
    signal,
  );
  const workspaceId = created.workspaceId;
  if (typeof workspaceId !== "string" || !workspaceId) {
    throw new Error("Paseo workspace create did not return workspaceId");
  }
  try {
    const imported = await importAgentIntoWorkspace(
      session,
      workspaceId,
      signal,
    );
    const importedTitle =
      typeof imported.title === "string" ? imported.title.trim() : "";
    if (importedTitle && importedTitle !== title) {
      await execJson(
        paseo,
        ["workspace", "rename", workspaceId, importedTitle, "--json"],
        signal,
      ).catch(() => undefined);
    }
  } catch (error) {
    await execJson(
      paseo,
      ["workspace", "archive", workspaceId, "--json"],
      signal,
    ).catch(() => undefined);
    throw error;
  }
}

async function importAgentIntoWorkspace(
  session: LocalSession,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<{ title?: string | null }> {
  const importer = await resolveImporter();
  const { stdout } = await execFileAsync(process.execPath, [importer], {
    signal,
    timeout: IMPORT_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      PASEO_IMPORT_JSON: JSON.stringify({
        provider: session.provider,
        sessionId: session.providerHandleId,
        cwd: session.cwd,
        workspaceId,
        labels: {
          [AUTO_SYNC_LABEL.split("=")[0]]: AUTO_SYNC_LABEL.split("=")[1],
        },
      }),
    },
  });
  try {
    return JSON.parse(stdout) as { title?: string | null };
  } catch {
    throw new Error(
      `Paseo import returned invalid JSON: ${stdout.slice(0, 200)}`,
    );
  }
}

async function execJson(
  command: string,
  args: string[],
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync(command, args, {
    signal,
    timeout: IMPORT_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  try {
    return JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new Error(`Paseo CLI returned invalid JSON: ${stdout.slice(0, 200)}`);
  }
}

function workspaceTitle(session: LocalSession): string {
  const raw = session.title?.trim() || session.sessionId;
  return raw.replace(/\s+/gu, " ").slice(0, 80);
}

async function resolveImporter(): Promise<string> {
  const paseoHome =
    process.env.PASEO_HOME?.trim() || path.join(homedir(), ".paseo");
  let config: { plugins?: Record<string, { path?: string }> };
  try {
    config = JSON.parse(
      await readFile(path.join(paseoHome, "config.json"), "utf8"),
    ) as {
      plugins?: Record<string, { path?: string }>;
    };
  } catch {
    throw new Error("Paseo config.json could not be read");
  }
  const pluginPath = config.plugins?.["paseo-auto-sync"]?.path;
  if (!pluginPath) {
    throw new Error(
      "paseo-auto-sync plugin path was not found in Paseo config",
    );
  }
  const candidate = path.join(pluginPath, "server", "paseo-import.mjs");
  await access(candidate);
  return candidate;
}

async function findPaseoCli(): Promise<string> {
  const pathCandidates = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, "paseo"));
  const candidates = [
    process.env.PASEO_CLI,
    ...pathCandidates,
    path.join(homedir(), ".local", "bin", "paseo"),
    "/Applications/Paseo.app/Contents/Resources/bin/paseo",
    "/usr/lib/paseo/resources/bin/paseo",
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // 继续检查下一处标准安装路径。
    }
  }

  throw new Error("Paseo CLI was not found");
}

async function walkFiles(root: string, extension: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        return walkFiles(entryPath, extension);
      }
      return entry.isFile() && entry.name.endsWith(extension)
        ? [entryPath]
        : [];
    }),
  );
  return nested.flat();
}

async function readFirstLine(file: string): Promise<string> {
  const stream = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      return line;
    }
    return "";
  } finally {
    lines.close();
    stream.destroy();
  }
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

function resolveConfiguredPath(
  value: string | undefined,
  fallback: string,
  homeDir: string,
): string {
  if (!value?.trim()) {
    return fallback;
  }
  if (value === "~") {
    return homeDir;
  }
  if (value.startsWith("~/")) {
    return path.join(homeDir, value.slice(2));
  }
  return path.resolve(value);
}

function sessionKey(provider: Provider, handle: string): string {
  return `${provider}\0${handle}`;
}

function createEmptyResult(
  skippedInvalid: Record<Provider, number>,
): SyncResult {
  return {
    discovered: { codex: 0, pi: 0 },
    imported: { codex: 0, pi: 0 },
    skippedRegistered: { codex: 0, pi: 0 },
    skippedInvalid,
    deferred: { codex: 0, pi: 0 },
    remaining: { codex: 0, pi: 0 },
    failed: { codex: 0, pi: 0 },
    deletedDangling: { codex: 0, pi: 0 },
    skippedRunningDangling: { codex: 0, pi: 0 },
    cleanupFailed: { codex: 0, pi: 0 },
    archivedEmptyWorkspaces: 0,
    workspaceArchiveFailed: 0,
  };
}

function isAlreadyImportedError(error: unknown): boolean {
  return errorMessage(error).includes("already imported");
}

function isActiveWriterError(error: unknown): boolean {
  return errorMessage(error).includes("already has an active writer");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveBatchSize(
  explicit: number | undefined,
  configured: string | undefined,
): number {
  const value = explicit ?? Number(configured);
  if (!Number.isFinite(value) || value < 1) {
    return DEFAULT_IMPORT_BATCH_SIZE;
  }
  return Math.min(Math.floor(value), MAX_IMPORT_BATCH_SIZE);
}

function resolveSyncIntervalMs(configured: string | undefined): number {
  const seconds = Number(configured);
  const boundedSeconds =
    Number.isFinite(seconds) && seconds >= 30
      ? Math.min(seconds, MAX_SYNC_INTERVAL_SECONDS)
      : DEFAULT_SYNC_INTERVAL_SECONDS;
  return boundedSeconds * 1000;
}

async function readSyncScope(
  env: NodeJS.ProcessEnv,
  homeDir: string,
): Promise<unknown> {
  const paseoHome = resolveConfiguredPath(
    env.PASEO_HOME,
    path.join(homeDir, ".paseo"),
    homeDir,
  );
  const configPath = path.join(
    paseoHome, "plugin-data", "paseo-auto-sync", "config.json",
  );
  try {
    return JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { projects: [], providers: ["pi"] };
    }
    throw error;
  }
}

function validateScope(
  value: unknown,
  homeDir: string,
): { projects: string[]; providers: Provider[] } {
  if (!value || typeof value !== "object") {
    throw new Error("Auto-sync config must be an object with a projects whitelist");
  }
  const { projects, providers = ["pi"] } = value as Record<string, unknown>;
  if (
    !Array.isArray(projects) ||
    !projects.every((p) =>
      typeof p === "string" && (path.isAbsolute(p) || p.startsWith("~/")),
    )
  ) {
    throw new Error("Auto-sync projects must be an array of absolute or ~/ paths");
  }
  if (
    !Array.isArray(providers) ||
    !providers.every((p) => p === "pi" || p === "codex")
  ) {
    throw new Error("Auto-sync providers must contain only pi or codex");
  }
  return {
    projects: projects.map((p: string) => resolveConfiguredPath(p, p, homeDir)),
    providers: providers as Provider[],
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("Session sync aborted");
  }
}
