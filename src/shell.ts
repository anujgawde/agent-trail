import { execa, ExecaError } from "execa";

export interface RunOptions {
  cwd?: string;
  timeout?: number;
}

export async function run(
  cmd: string,
  args: string[],
  opts: RunOptions = {},
): Promise<string> {
  const { cwd, timeout = 10_000 } = opts;
  try {
    const result = await execa(cmd, args, { cwd, timeout });
    return result.stdout;
  } catch (err) {
    if (err instanceof ExecaError) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          `${cmd} not found — install ${cmd} and retry`,
        );
      }
      throw new Error(
        `${cmd} exited with code ${err.exitCode}: ${err.stderr}`,
      );
    }
    throw err;
  }
}
