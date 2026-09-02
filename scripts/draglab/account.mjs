// ★ THE FAKE ACCOUNT — a local stand-in for the whole signed-in server, so every piece of
// cross-device "monkey business" can be driven on one machine with no D1, no OAuth and no second
// browser. The bugs this class of code has are ALL about ORDER: the account blob lands after mount,
// two devices write in the wrong sequence, a push is refused and nobody says so. None of them are
// reachable from a unit test, and all of them are one `page.route` away from being reproducible.
//
//   const acct = await fakeAccount(page, { settings: { fxBanks: { eq: MINE } } });
//   …drive the app…
//   acct.pushes            // every PUT body the app sent, in order
//   acct.stored            // what the "server" now holds (last accepted PUT)
//   acct.setRemote(data, updatedAt)   // another device just changed it
//   acct.fail(413)         // the server starts refusing — the cap, or anything else
//   await acct.done()      // unroute; ALWAYS in a finally
export async function fakeAccount(page, opts = {}) {
  const acct = {
    user: opts.user ?? { id: "u1", handle: "tester", email: "t@example.com" },
    /** What the server holds. `updatedAt` in the FUTURE by default so the sign-in reconcile adopts
     *  it — the whole point is to test the inbound path, and a stamp older than local is ignored. */
    stored: opts.settings ?? null,
    updatedAt: opts.updatedAt ?? Date.now() + 60_000,
    /** Every PUT body, in order — the outbound leg's actual evidence. */
    pushes: [],
    /** Non-zero = the server refuses every PUT with this status (413 is the 256 KB cap). */
    failWith: 0,
    setRemote(data, updatedAt = Date.now() + 60_000) {
      acct.stored = data;
      acct.updatedAt = updatedAt;
    },
    fail(status) {
      acct.failWith = status;
    },
    /** The last thing the app successfully stored — what a SECOND device would pull. */
    get lastPush() {
      return acct.pushes[acct.pushes.length - 1]?.data ?? null;
    },
    async done() {
      await page.unroute("**/api/me").catch(() => {});
      await page.unroute("**/api/me/settings").catch(() => {});
    },
  };
  await page.route("**/api/me", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user: acct.user, connections: [] }) }),
  );
  await page.route("**/api/me/settings", (r) => {
    if (r.request().method() === "PUT") {
      let body = null;
      try { body = JSON.parse(r.request().postData() || "{}"); } catch { /* ignore */ }
      if (acct.failWith) return r.fulfill({ status: acct.failWith, contentType: "application/json", body: JSON.stringify({ error: "nope" }) });
      if (body) {
        acct.pushes.push(body);
        acct.stored = body.data;
        acct.updatedAt = body.updatedAt ?? Date.now();
      }
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, updatedAt: acct.updatedAt }) });
    }
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: acct.stored, updatedAt: acct.stored ? acct.updatedAt : 0 }) });
  });
  return acct;
}

/** A bank shaped the way the app stores one — a section holding references by NAME. */
export const bankOf = (section, ...presetNames) => ({ rows: [{ name: section, sep: true, items: presetNames.map((ref) => ({ ref })) }], gone: [] });
