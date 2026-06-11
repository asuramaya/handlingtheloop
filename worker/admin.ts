// Admin worker for admin.handlingtheloop.com — a SEPARATE deployable from the
// public `htl` worker (no admin code ships in the user-facing app, and its secrets
// never touch it). Binds the SAME htl-db D1 + htl-audio R2. Every request is gated
// by Cloudflare Access (verified in server/access.ts). Config: wrangler.admin.jsonc.
import { handleAdmin, type AdminEnv } from "../server/admin";

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export default {
  async fetch(req: Request, env: AdminEnv, ctx: ExecutionContext): Promise<Response> {
    return handleAdmin(req, env, ctx);
  },
};
