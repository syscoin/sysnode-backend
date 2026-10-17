const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { deploy, APPS } = require("../deploy/automation/host-deploy.cjs");

const OLD = "11".repeat(20);
const NEXT = "aa".repeat(20);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const error = (code) => Object.assign(new Error(code), { code });
const directories = [];

function fixture(app = "backend") {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "sysnode-deploy-test-")
  );
  directories.push(temporary);
  const appsRoot = path.join(temporary, "apps");
  const job = path.join(temporary, "job");
  fs.mkdirSync(job, { recursive: true });
  const state = { schema: "original-schema", apps: {} };
  for (const name of Object.keys(APPS)) {
    const root = path.join(appsRoot, APPS[name].directory);
    fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
    fs.mkdirSync(path.join(root, "build"), { recursive: true });
    fs.writeFileSync(path.join(root, ".env"), `PRIVATE_${name}=preserved\n`);
    fs.writeFileSync(path.join(root, "code"), "previous-code");
    fs.writeFileSync(
      path.join(root, "node_modules", "version"),
      "previous-dependencies"
    );
    fs.writeFileSync(path.join(root, "build", "version"), "previous-build");
    state.apps[name] = {
      head: OLD,
      pid: name === "backend" ? 10 : 20,
      online: true,
    };
  }
  const root = path.join(appsRoot, APPS[app].directory);
  const other = app === "backend" ? "frontend" : "backend";
  const database = path.join(
    appsRoot,
    APPS.backend.directory,
    "data",
    "sysnode.db"
  );
  fs.mkdirSync(path.dirname(database), { recursive: true });
  fs.writeFileSync(database, "existing-user-data");
  const originalDatabase = fs.statSync(database);
  const config = {
    appsRoot,
    stateRoot: temporary,
    pm2: "/fake/pm2",
    network: "testnet",
    minFreeBytes: 1,
  };
  const request = { sha: NEXT, runId: "1234", attempt: "1" };
  const commands = [];
  const io = {
    verifyCi: jest.fn(async () => undefined),
    verifySource: jest.fn(() => root),
    sourceSchemaFence: jest.fn(() => true),
    capture: jest.fn(() => ({
      apps: Object.fromEntries(
        Object.entries(state.apps).map(([name, record]) => [
          name,
          {
            head: record.head,
            pid: record.pid,
            launch: `${name}-original-launch`,
            envHash: digest(
              fs.readFileSync(path.join(appsRoot, APPS[name].directory, ".env"))
            ),
          },
        ])
      ),
      database: {
        path: database,
        dev: originalDatabase.dev,
        ino: originalDatabase.ino,
      },
    })),
    checkDatabase: jest.fn(async (_config, file, backup) => {
      if (backup) fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
      return state.schema;
    }),
    rehearseSchema: jest.fn(async () => undefined),
    retryHealth: jest.fn(async () => undefined),
    command: jest.fn((file, args, options = {}) => {
      commands.push([file, [...args]]);
      if (file === config.pm2) {
        const name = Object.keys(APPS).find(
          (key) => APPS[key].directory === args[1]
        );
        if (args[0] === "stop") state.apps[name].online = false;
        if (args[0] === "restart") {
          state.apps[name].online = true;
          state.apps[name].pid += 1;
        }
      } else if (file === "git" && args.includes("archive")) {
        fs.writeFileSync(
          args[args.indexOf("--output") + 1],
          "synthetic-archive"
        );
      } else if (file === "git" && args.includes("merge")) {
        state.apps[app].head = NEXT;
        fs.writeFileSync(path.join(root, "code"), "candidate-code");
      } else if (file === "git" && args.includes("switch")) {
        state.apps[app].head = OLD;
        fs.writeFileSync(path.join(root, "code"), "previous-code");
      } else if (file === "npm" && args[0] === "ci") {
        fs.mkdirSync(path.join(options.cwd, "node_modules"), {
          recursive: true,
        });
        fs.writeFileSync(
          path.join(options.cwd, "node_modules", "version"),
          "candidate-dependencies"
        );
      } else if (file === "npm" && args.includes("build")) {
        fs.mkdirSync(path.join(options.cwd, "build"), { recursive: true });
        fs.writeFileSync(
          path.join(options.cwd, "build", "version"),
          "candidate-build"
        );
      }
    }),
    git: jest.fn(() => ""),
  };
  const originalOther = JSON.stringify(state.apps[other]);
  const originalEnv = fs.readFileSync(path.join(root, ".env"), "utf8");
  const assertPreserved = () => {
    expect(JSON.stringify(state.apps[other])).toBe(originalOther);
    expect(fs.readFileSync(path.join(root, ".env"), "utf8")).toBe(originalEnv);
    expect(fs.statSync(database).ino).toBe(originalDatabase.ino);
  };
  const pm2Commands = () =>
    commands.filter(([file]) => file === config.pm2).map(([, args]) => args[0]);
  return {
    app,
    other,
    root,
    database,
    job,
    state,
    config,
    request,
    io,
    commands,
    assertPreserved,
    pm2Commands,
  };
}

afterEach(() => {
  jest.restoreAllMocks();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

it.each(["backend", "frontend"])(
  "deploys %s with real directory swaps while preserving the other app and database",
  async (app) => {
    const f = fixture(app);
    await deploy(f.config, app, f.request, f.job, f.io);
    expect(f.state.apps[app].head).toBe(NEXT);
    expect(f.pm2Commands()).toEqual(["stop", "restart"]);
    expect(
      fs.readFileSync(path.join(f.root, "node_modules/version"), "utf8")
    ).toBe("candidate-dependencies");
    if (app === "frontend") {
      expect(fs.readFileSync(path.join(f.root, "build/version"), "utf8")).toBe(
        "candidate-build"
      );
      const build = f.io.command.mock.calls.find(
        ([file, args]) => file === "npm" && args.includes("build")
      );
      expect(build[2].env.REACT_APP_NETWORK).toBe("testnet");
      expect(
        Object.keys(build[2].env).some((key) => key.startsWith("PRIVATE_"))
      ).toBe(false);
    }
    expect(
      fs.readFileSync(path.join(f.job, "backup/node_modules/version"), "utf8")
    ).toBe("previous-dependencies");
    expect(fs.readFileSync(f.database, "utf8")).toBe("existing-user-data");
    f.assertPreserved();
  }
);

it("does not stop or mutate the live app when CI verification fails", async () => {
  const f = fixture();
  f.io.verifyCi.mockRejectedValue(error("ci_not_successful"));
  await expect(deploy(f.config, f.app, f.request, f.job, f.io)).rejects.toThrow(
    "ci_not_successful"
  );
  expect(f.pm2Commands()).toEqual([]);
  expect(f.state.apps[f.app].head).toBe(OLD);
  f.assertPreserved();
});

it("refuses schema source changes before staging or stopping the live app", async () => {
  const f = fixture();
  f.io.sourceSchemaFence.mockReturnValue(false);
  await expect(deploy(f.config, f.app, f.request, f.job, f.io)).rejects.toThrow(
    "schema_source_requires_manual_rollout"
  );
  expect(f.pm2Commands()).toEqual([]);
  expect(fs.existsSync(path.join(f.job, "stage"))).toBe(false);
  f.assertPreserved();
});

it("does not stop or replace the live app after a failed staged install", async () => {
  const f = fixture();
  const execute = f.io.command.getMockImplementation();
  f.io.command.mockImplementation((file, args, options) => {
    if (file === "npm" && args[0] === "ci") throw error("install_failed");
    return execute(file, args, options);
  });
  await expect(deploy(f.config, f.app, f.request, f.job, f.io)).rejects.toThrow(
    "install_failed"
  );
  expect(f.pm2Commands()).toEqual([]);
  expect(
    fs.readFileSync(path.join(f.root, "node_modules/version"), "utf8")
  ).toBe("previous-dependencies");
  f.assertPreserved();
});

it.each(["original-node_modules", "node_modules", "build"])(
  "restores real files after the %s replacement rename fails",
  async (member) => {
    const f = fixture("frontend");
    const rename = fs.renameSync;
    let failed = false;
    jest.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      const failedSource =
        member === "original-node_modules"
          ? path.join(f.root, "node_modules")
          : path.join(f.job, "stage", member);
      if (!failed && source === failedSource) {
        failed = true;
        throw error("rename_failed");
      }
      return rename(source, destination);
    });
    await expect(
      deploy(f.config, f.app, f.request, f.job, f.io)
    ).rejects.toThrow("deployment_failed_previous_code_restored");
    expect(failed).toBe(true);
    expect(f.state.apps.frontend).toMatchObject({ head: OLD, online: true });
    expect(
      fs.readFileSync(path.join(f.root, "node_modules/version"), "utf8")
    ).toBe("previous-dependencies");
    expect(fs.readFileSync(path.join(f.root, "build/version"), "utf8")).toBe(
      "previous-build"
    );
    expect(fs.readFileSync(path.join(f.root, "code"), "utf8")).toBe(
      "previous-code"
    );
    f.assertPreserved();
  }
);

it("recovers the previous app when the first stop succeeds remotely but reports failure", async () => {
  const f = fixture();
  const execute = f.io.command.getMockImplementation();
  let ambiguous = false;
  f.io.command.mockImplementation((file, args, options) => {
    const result = execute(file, args, options);
    if (file === f.config.pm2 && args[0] === "stop" && !ambiguous) {
      ambiguous = true;
      throw error("ambiguous_stop");
    }
    return result;
  });
  await expect(deploy(f.config, f.app, f.request, f.job, f.io)).rejects.toThrow(
    "deployment_failed_previous_code_restored"
  );
  expect(f.state.apps.backend).toMatchObject({ head: OLD, online: true });
  expect(f.pm2Commands()).toEqual(["stop", "stop", "restart"]);
  f.assertPreserved();
});

it("rolls back failed candidate health without restoring a stale database snapshot", async () => {
  const f = fixture();
  f.io.retryHealth.mockImplementation(async () => {
    if (f.state.apps.backend.head === NEXT) {
      fs.appendFileSync(f.database, "|new-user-write");
      throw error("unhealthy_candidate");
    }
  });
  await expect(deploy(f.config, f.app, f.request, f.job, f.io)).rejects.toThrow(
    "deployment_failed_previous_code_restored"
  );
  expect(f.state.apps.backend).toMatchObject({ head: OLD, online: true });
  expect(fs.readFileSync(f.database, "utf8")).toBe(
    "existing-user-data|new-user-write"
  );
  expect(
    fs.readFileSync(path.join(f.job, "backup/precutover.sqlite"), "utf8")
  ).toBe("existing-user-data");
  f.assertPreserved();
});

it("rolls back when a successful-looking restart leaves the original process running", async () => {
  const f = fixture();
  const execute = f.io.command.getMockImplementation();
  let firstRestart = true;
  f.io.command.mockImplementation((file, args, options) => {
    const previousPid = f.state.apps.backend.pid;
    const result = execute(file, args, options);
    if (file === f.config.pm2 && args[0] === "restart" && firstRestart) {
      firstRestart = false;
      f.state.apps.backend.pid = previousPid;
    }
    return result;
  });
  await expect(deploy(f.config, f.app, f.request, f.job, f.io)).rejects.toThrow(
    "deployment_failed_previous_code_restored"
  );
  expect(f.pm2Commands()).toEqual(["stop", "restart", "stop", "restart"]);
  expect(f.state.apps.backend).toMatchObject({ head: OLD, online: true });
  expect(fs.readFileSync(path.join(f.root, "node_modules/version"), "utf8")).toBe(
    "previous-dependencies"
  );
  f.assertPreserved();
});

it("stops a candidate with unexpected schema changes and never restores the database or restarts old code", async () => {
  const f = fixture();
  f.io.retryHealth.mockImplementation(async () => {
    f.state.schema = "unexpected-schema";
    fs.appendFileSync(f.database, "|new-schema-data");
  });
  await expect(deploy(f.config, f.app, f.request, f.job, f.io)).rejects.toThrow(
    "manual_recovery_schema_changed"
  );
  expect(f.state.apps.backend).toMatchObject({ head: NEXT, online: false });
  expect(f.pm2Commands()).toEqual(["stop", "restart", "stop"]);
  expect(fs.readFileSync(f.database, "utf8")).toBe(
    "existing-user-data|new-schema-data"
  );
  expect(
    f.commands.some(([file, args]) => file === "git" && args.includes("switch"))
  ).toBe(false);
  f.assertPreserved();
});

it("stops a candidate when database verification becomes unreadable", async () => {
  const f = fixture();
  const check = f.io.checkDatabase.getMockImplementation();
  f.io.checkDatabase.mockImplementation(async (...args) => {
    if (f.state.apps.backend.head === NEXT) throw error("integrity_unreadable");
    return check(...args);
  });
  await expect(
    deploy(f.config, f.app, f.request, f.job, f.io)
  ).rejects.toThrow();
  expect(f.state.apps.backend.online).toBe(false);
  expect(f.pm2Commands()).toEqual(["stop", "restart", "stop"]);
  expect(fs.readFileSync(f.database, "utf8")).toBe("existing-user-data");
  f.assertPreserved();
});

it.each(["other-app", "environment"])(
  "refuses cutover when %s changes during staging",
  async (kind) => {
    const f = fixture();
    f.io.rehearseSchema.mockImplementation(async () => {
      if (kind === "other-app") f.state.apps[f.other].pid += 1;
      else
        fs.appendFileSync(path.join(f.root, ".env"), "EXTERNAL_CHANGE=keep\n");
    });
    await expect(
      deploy(f.config, f.app, f.request, f.job, f.io)
    ).rejects.toThrow();
    expect(f.pm2Commands()).toEqual([]);
    expect(f.state.apps.backend).toMatchObject({ head: OLD, online: true });
    expect(
      fs.readFileSync(path.join(f.root, "node_modules/version"), "utf8")
    ).toBe("previous-dependencies");
    if (kind === "environment")
      expect(fs.readFileSync(path.join(f.root, ".env"), "utf8")).toContain(
        "EXTERNAL_CHANGE=keep"
      );
  }
);

it("stops instead of overwriting an environment changed after cutover", async () => {
  const f = fixture();
  f.io.retryHealth.mockImplementation(async () => {
    fs.appendFileSync(path.join(f.root, ".env"), "EXTERNAL_CHANGE=keep\n");
  });
  await expect(deploy(f.config, f.app, f.request, f.job, f.io)).rejects.toThrow(
    "manual_recovery_configuration_changed"
  );
  expect(f.state.apps.backend).toMatchObject({ head: NEXT, online: false });
  expect(fs.readFileSync(path.join(f.root, ".env"), "utf8")).toContain(
    "EXTERNAL_CHANGE=keep"
  );
  expect(fs.readFileSync(f.database, "utf8")).toBe("existing-user-data");
});
