import { spawn } from "node:child_process";
import { platform } from "node:os";
import { join } from "node:path";

export interface BrowserLaunchSpec {
  command: string;
  args: string[];
}

export function browserLaunchSpec(
  rawUrl: string,
  currentPlatform: NodeJS.Platform = platform(),
  systemRoot = process.env.SystemRoot,
): BrowserLaunchSpec | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return null;
  }

  const targetUrl = url.toString();
  if (currentPlatform === "win32") {
    // Invoke the registered HTTP(S) protocol handler directly. This avoids cmd.exe's
    // quoting rules, which can turn a valid URL into a file or network path.
    return {
      command: systemRoot ? join(systemRoot, "System32", "rundll32.exe") : "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", targetUrl],
    };
  }

  if (currentPlatform === "darwin") {
    return { command: "open", args: [targetUrl] };
  }

  // xdg-open delegates to the user's configured browser on Linux desktop environments.
  return { command: "xdg-open", args: [targetUrl] };
}

export async function openBrowser(url: string): Promise<boolean> {
  const spec = browserLaunchSpec(url);
  if (!spec) {
    return false;
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (opened: boolean) => {
      if (!settled) {
        settled = true;
        resolve(opened);
      }
    };

    try {
      const child = spawn(spec.command, spec.args, { detached: true, stdio: "ignore" });
      child.once("error", () => finish(false));
      child.once("spawn", () => {
        child.unref();
        finish(true);
      });
    } catch {
      finish(false);
    }
  });
}
