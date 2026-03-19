import { PassThrough } from "node:stream";
import { createTools } from "../src/tools";
import { assertOperationAllowed } from "../src/guards";
import { PluginConfig } from "../src/types";
import { vi } from 'vitest'

function baseConfig(): PluginConfig {
  return {
    socketPath: "/var/run/docker.sock",
    readOnly: false,
    allowedOperations: undefined,
    composeProjects: [],
    timeoutMs: 15000
  };
}

describe("docker tools", () => {
  test("docker_ps returns normalized container list", async () => {
    const docker = {
      listContainers: vi.fn().mockResolvedValue([
        {
          Id: "abc",
          Names: ["/web"],
          Image: "nginx:latest",
          State: "running",
          Status: "Up 1 minute"
        }
      ])
    } as unknown as Parameters<typeof createTools>[0]["docker"];

    const tools = createTools({ docker, config: baseConfig() });
    const result = (await tools.docker_ps({ all: true })) as Array<Record<string, string>>;

    expect(result[0]).toEqual({
      id: "abc",
      name: "web",
      image: "nginx:latest",
      state: "running",
      status: "Up 1 minute"
    });
  });

  test("docker_logs returns text logs", async () => {
    const docker = {
      getContainer: vi.fn().mockReturnValue({
        logs: vi.fn().mockResolvedValue(Buffer.from("hello\nworld"))
      })
    } as unknown as Parameters<typeof createTools>[0]["docker"];

    const tools = createTools({ docker, config: baseConfig() });
    const result = (await tools.docker_logs({ containerId: "abc", tail: 20 })) as Record<
      string,
      unknown
    >;

    expect(result.logs).toContain("hello");
  });

  test("docker_logs follow mode collects streamed data", async () => {
    const mockStream = new PassThrough();
    const docker = {
      getContainer: vi.fn().mockReturnValue({
        logs: vi.fn().mockResolvedValue(mockStream)
      })
    } as unknown as Parameters<typeof createTools>[0]["docker"];

    const tools = createTools({ docker, config: baseConfig() });

    setTimeout(() => {
      mockStream.write(Buffer.from("line1\n"));
      mockStream.write(Buffer.from("line2\n"));
      mockStream.end();
    }, 10);

    const result = (await tools.docker_logs({
      containerId: "abc",
      follow: true,
      followDurationMs: 5000
    })) as Record<string, unknown>;

    expect(result.follow).toBe(true);
    expect(result.logs).toContain("line1");
    expect(result.logs).toContain("line2");
  });

  test("docker_logs follow mode respects duration limit", async () => {
    const mockStream = new PassThrough();
    const docker = {
      getContainer: vi.fn().mockReturnValue({
        logs: vi.fn().mockResolvedValue(mockStream)
      })
    } as unknown as Parameters<typeof createTools>[0]["docker"];

    const tools = createTools({ docker, config: baseConfig() });

    mockStream.write(Buffer.from("initial\n"));

    const result = (await tools.docker_logs({
      containerId: "abc",
      follow: true,
      followDurationMs: 100
    })) as Record<string, unknown>;

    expect(result.follow).toBe(true);
    expect(result.durationMs).toBe(100);
    expect(result.logs).toContain("initial");
  });

  test("docker_inspect returns payload", async () => {
    const docker = {
      getContainer: vi.fn().mockReturnValue({
        inspect: vi.fn().mockResolvedValue({ Id: "abc", Config: { Image: "redis" } })
      })
    } as unknown as Parameters<typeof createTools>[0]["docker"];

    const tools = createTools({ docker, config: baseConfig() });
    const result = (await tools.docker_inspect({ containerId: "abc" })) as { Id: string };

    expect(result.Id).toBe("abc");
  });

  test("docker_exec runs command and returns stdout/stderr", async () => {
    const execStream = new PassThrough();
    const mockExec = {
      start: vi.fn().mockResolvedValue(execStream),
      inspect: vi.fn().mockResolvedValue({ ExitCode: 0 })
    };
    const mockModem = {
      demuxStream: vi.fn((stream: PassThrough, stdout: PassThrough, _stderr: PassThrough) => {
        stream.on("data", (chunk: Buffer) => stdout.write(chunk));
        stream.on("end", () => stdout.end());
      })
    };
    const docker = {
      getContainer: vi.fn().mockReturnValue({
        exec: vi.fn().mockResolvedValue(mockExec)
      }),
      modem: mockModem
    } as unknown as Parameters<typeof createTools>[0]["docker"];

    const tools = createTools({ docker, config: baseConfig() });

    setTimeout(() => {
      execStream.write(Buffer.from("hello from exec\n"));
      execStream.end();
    }, 10);

    const result = (await tools.docker_exec({
      containerId: "abc",
      command: ["echo", "hello from exec"]
    })) as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(result.action).toBe("exec");
    expect(result.containerId).toBe("abc");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello from exec");
  });

  test("docker_exec passes workdir and env options", async () => {
    const execStream = new PassThrough();
    const mockExec = {
      start: vi.fn().mockResolvedValue(execStream),
      inspect: vi.fn().mockResolvedValue({ ExitCode: 0 })
    };
    const containerObj = {
      exec: vi.fn().mockResolvedValue(mockExec)
    };
    const docker = {
      getContainer: vi.fn().mockReturnValue(containerObj),
      modem: {
        demuxStream: vi.fn((_stream: PassThrough, stdout: PassThrough, _stderr: PassThrough) => {
          // Pipe the exec stream into stdout so end propagates
          _stream.pipe(stdout);
        })
      }
    } as unknown as Parameters<typeof createTools>[0]["docker"];

    const tools = createTools({ docker, config: baseConfig() });

    // End the stream after a tick so the promise listener is registered first
    setTimeout(() => execStream.end(), 10);

    await tools.docker_exec({
      containerId: "abc",
      command: ["ls", "-la"],
      workdir: "/app",
      env: ["FOO=bar"]
    });

    expect(containerObj.exec).toHaveBeenCalledWith(
      expect.objectContaining({
        Cmd: ["ls", "-la"],
        WorkingDir: "/app",
        Env: ["FOO=bar"]
      })
    );
  });

  test("docker_exec is blocked in readOnly mode", async () => {
    const docker = {} as Parameters<typeof createTools>[0]["docker"];
    const config: PluginConfig = { ...baseConfig(), readOnly: true };
    const tools = createTools({ docker, config });

    await expect(
      tools.docker_exec({ containerId: "abc", command: ["ls"] })
    ).rejects.toThrow(/readOnly/);
  });

  test("docker_exec throws when command is empty", async () => {
    const docker = {} as Parameters<typeof createTools>[0]["docker"];
    const tools = createTools({ docker, config: baseConfig() });

    await expect(
      tools.docker_exec({ containerId: "abc", command: [] })
    ).rejects.toThrow(/non-empty/);
  });
});

describe("docker_compose_ps", () => {
  function composeConfig(): PluginConfig {
    return {
      ...baseConfig(),
      composeProjects: [{ name: "myapp", path: "/opt/myapp" }]
    };
  }

  test("returns parsed service list from compose ps JSON output", async () => {
    const jsonLine1 = JSON.stringify({ Name: "myapp-web-1", State: "running", Service: "web" });
    const jsonLine2 = JSON.stringify({ Name: "myapp-db-1", State: "running", Service: "db" });
    const mockRunner = vi.fn().mockResolvedValue({
      stdout: `${jsonLine1}\n${jsonLine2}\n`,
      stderr: ""
    });

    const docker = {} as Parameters<typeof createTools>[0]["docker"];
    const tools = createTools({ docker, config: composeConfig(), composeRunner: mockRunner });
    const result = (await tools.docker_compose_ps({ project: "myapp" })) as {
      ok: boolean;
      action: string;
      project: string;
      services: Array<{ Name: string; State: string; Service: string }>;
    };

    expect(result.ok).toBe(true);
    expect(result.action).toBe("compose_ps");
    expect(result.project).toBe("myapp");
    expect(result.services).toHaveLength(2);
    expect(result.services[0]).toEqual({ Name: "myapp-web-1", State: "running", Service: "web" });
    expect(result.services[1]).toEqual({ Name: "myapp-db-1", State: "running", Service: "db" });
    expect(mockRunner).toHaveBeenCalledWith("/opt/myapp", ["ps", "--format", "json"], 15000);
  });

  test("returns empty services array when no containers are running", async () => {
    const mockRunner = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });

    const docker = {} as Parameters<typeof createTools>[0]["docker"];
    const tools = createTools({ docker, config: composeConfig(), composeRunner: mockRunner });
    const result = (await tools.docker_compose_ps({ project: "myapp" })) as {
      services: unknown[];
    };

    expect(result.services).toEqual([]);
  });

  test("passes service filter arguments to compose command", async () => {
    const mockRunner = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });

    const docker = {} as Parameters<typeof createTools>[0]["docker"];
    const tools = createTools({ docker, config: composeConfig(), composeRunner: mockRunner });
    await tools.docker_compose_ps({ project: "myapp", services: ["web"] });

    expect(mockRunner).toHaveBeenCalledWith("/opt/myapp", ["ps", "--format", "json", "web"], 15000);
  });

  test("is allowed in readOnly mode", () => {
    const config: PluginConfig = { ...baseConfig(), readOnly: true };
    expect(() => assertOperationAllowed("compose_ps", config)).not.toThrow();
  });
});

describe("allowedOperations guard", () => {
  test("blocks write operations in readOnly mode", () => {
    const config: PluginConfig = {
      ...baseConfig(),
      readOnly: true
    };

    expect(() => assertOperationAllowed("start", config)).toThrow(/readOnly/);
    expect(() => assertOperationAllowed("ps", config)).not.toThrow();
  });

  test("blocks non-whitelisted operation", () => {
    const config: PluginConfig = {
      ...baseConfig(),
      allowedOperations: ["ps", "inspect"]
    };

    expect(() => assertOperationAllowed("logs", config)).toThrow(/allowedOperations/);
  });
});
