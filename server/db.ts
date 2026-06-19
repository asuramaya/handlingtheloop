// D1 data layer for the SaaS account/sync features — a thin, typed wrapper (no ORM).
// The implementation lives in ./db/<domain>.ts, split by feature so concurrent work on
// (say) the social graph and the lyrics cache no longer touches one 1000-line file.
// This barrel re-exports the whole surface, so `import { ... } from "./db"` is unchanged.
export * from "./db/core";
export * from "./db/identity";
export * from "./db/social";
export * from "./db/rooms";
export * from "./db/sets";
export * from "./db/connections";
export * from "./db/community";
export * from "./db/transcripts";
export * from "./db/analysis";
export * from "./db/admin";
export * from "./db/reports";
export * from "./db/userdata";
