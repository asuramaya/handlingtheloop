// Google device-code sign-in. Stateless pass-throughs: the BROWSER holds the device_code /
// tokens and polls; the Worker only forwards to Google. Nothing is stored here.
import { type Env, json } from "../shared";
import { oauthCreds, pollDeviceAuth, refreshAccessToken, startDeviceAuth } from "../../server/oauth";

export async function handleAuthRoutes(url: URL, req: Request, env: Env): Promise<Response | null> {
  switch (url.pathname) {
    case "/api/auth/device": {
      if (req.method !== "POST") return json(405, { error: "POST only" });
      return json(200, await startDeviceAuth(oauthCreds(env)));
    }
    case "/api/auth/poll": {
      if (req.method !== "POST") return json(405, { error: "POST only" });
      const { device_code } = (await req.json().catch(() => ({}))) as { device_code?: string };
      if (!device_code) return json(400, { error: "missing device_code" });
      return json(200, await pollDeviceAuth(oauthCreds(env), device_code));
    }
    case "/api/auth/refresh": {
      if (req.method !== "POST") return json(405, { error: "POST only" });
      const { refresh_token } = (await req.json().catch(() => ({}))) as { refresh_token?: string };
      if (!refresh_token) return json(400, { error: "missing refresh_token" });
      return json(200, await refreshAccessToken(oauthCreds(env), refresh_token));
    }
    default:
      return null;
  }
}
