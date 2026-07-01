import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { WorkspaceService } from "./service.js";

async function parseJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body) as Record<string, unknown>);
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function idFromPath(pathname: string, suffix = ""): string | null {
  const pattern = suffix
    ? new RegExp(`^/workspaces/([^/]+)/${suffix}$`)
    : /^\/workspaces\/([^/]+)$/;
  const match = pathname.match(pattern);
  return match ? decodeURIComponent(match[1]) : null;
}

export function createControlPlaneServer(service: WorkspaceService): Server {
  return createServer(async (req, res) => {
    res.setHeader("Connection", "close");
    const method = req.method || "GET";
    const parsedUrl = new URL(req.url || "/", "http://localhost");

    try {
      if (method === "POST" && parsedUrl.pathname === "/workspaces") {
        const body = await parseJson(req);
        const created = await service.createWorkspace({
          customerId: String(body.customerId || ""),
          region: String(body.region || "ITBG-1"),
          flavor: body.flavor == null ? undefined : String(body.flavor),
        });
        const { bootstrapToken, ...workspace } = created;
        sendJson(res, 201, { workspace, bootstrapToken });
        return;
      }

      const workspaceId = idFromPath(parsedUrl.pathname);
      if (method === "GET" && workspaceId) {
        sendJson(res, 200, { workspace: service.getWorkspace(workspaceId) });
        return;
      }

      const destroyWorkspaceId = idFromPath(parsedUrl.pathname, "destroy");
      if (method === "POST" && destroyWorkspaceId) {
        sendJson(res, 200, { workspace: await service.destroyWorkspace(destroyWorkspaceId) });
        return;
      }

      const eventsWorkspaceId = idFromPath(parsedUrl.pathname, "events");
      if (method === "GET" && eventsWorkspaceId) {
        sendJson(res, 200, { events: service.getWorkspaceEvents(eventsWorkspaceId) });
        return;
      }

      if (method === "POST" && parsedUrl.pathname === "/appliance/register") {
        const body = await parseJson(req);
        sendJson(res, 200, await service.registerAppliance({ bootstrapToken: String(body.bootstrapToken || "") }) as any);
        return;
      }

      if (method === "POST" && parsedUrl.pathname === "/appliance/heartbeat") {
        const body = await parseJson(req);
        const health = typeof body.health === "object" && body.health !== null
          ? body.health as Record<string, unknown>
          : {};
        sendJson(res, 200, {
          workspace: await service.recordHeartbeat({
            workspaceId: String(body.workspaceId || ""),
            applianceId: String(body.applianceId || ""),
            health,
          }),
        });
        return;
      }

      sendJson(res, 404, { error: "Not Found" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = /not found/i.test(message) ? 404 : 400;
      sendJson(res, status, { error: message });
    }
  });
}
