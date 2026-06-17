// Settings ▸ About — static product blurb, privacy/terms disclosures, FAQ. No props,
// no state; split out of SettingsPanel so the giant tab tree isn't one render block.

function Faq({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <div className="faq-item">
      <div className="faq-q">{q}</div>
      <p className="faq-a">{children}</p>
    </div>
  );
}

export function AboutTab() {
  return (
    <div className="settings-info">
      <h3>Handling The Loop</h3>
      <p className="settings-hint">
        A serverless, in-browser DJ rig: two decks, waveform scrubbing with real vinyl feel, beat-matched mixing,
        native key/BPM detection, and on-device stem separation — with YouTube (plus your Spotify / YouTube
        playlists) as your crate. Everything runs in this tab plus one Cloudflare Worker. No install, and nothing
        to sign up for to start.
      </p>
      <ul className="info-list">
        <li>Search YouTube or paste a video / playlist link to pull tracks in.</li>
        <li>Drag the waveform to scrub; the jog feel is tunable in the Deck tab.</li>
        <li>Audio, stems, and analysis are cached and shared, so a track is fetched and separated once.</li>
      </ul>

      <details className="policy">
        <summary>Privacy — what's collected, what isn't</summary>
        <p className="settings-hint">
          <strong>htl works with no account and no sign-in</strong> — by default it's anonymous. There are no ad
          networks, no third-party analytics profiles, and nothing is sold. Your library, decks, cue points, and
          settings live in <em>this browser</em> (localStorage), not on our servers.
        </p>
        <ul className="info-list">
          <li>
            <strong>Audio proxy.</strong> A browser can't fetch YouTube's audio servers directly (they block
            cross-origin requests), so our Cloudflare Worker resolves the stream server-side and re-serves the raw
            bytes to your browser, which decodes them locally for the decks. Your browser only ever talks to our
            own Worker (same origin) — never an ad/tracking host.
          </li>
          <li>
            <strong>Streaming cookie (optional).</strong> The only way to load brand-new tracks past YouTube's
            bot check is a youtube.com cookie. It's held <strong>in memory for this browser session only</strong>
            — never written to disk, trimmed to the minimum cookies, auto-expiring, and gone when you close the
            tab. It's sent only to our Worker, which forwards it to YouTube and <strong>never stores, logs, or
            shares it</strong>.
          </li>
          <li>
            <strong>Google sign-in token (optional).</strong> Used only to browse <em>your</em> YouTube
            playlists. It stays in this browser and is browse-only (it can't fetch audio). Revoke anytime at
            Google's “Third-party access”.
          </li>
          <li>
            <strong>htl account (optional).</strong> If you sign in to sync playlists, your session is an
            httpOnly cookie and your Google / Spotify tokens are <strong>encrypted at rest</strong> in our
            database, used only to read and write the playlists you choose to sync. Disconnect any service from
            the Accounts tab.
          </li>
        </ul>
      </details>

      <details className="policy">
        <summary>The shared community cache &amp; why it's built this way</summary>
        <p className="settings-hint">
          Resolved audio, separated stems, and analysis (BPM, key, beatgrid) are cached by <em>YouTube video
          id</em> and shared across everyone — so a track is fetched from YouTube once and separated once, then
          loads instantly for the next person. Stem separation is heavy, so pooling the result is what makes it
          free and fast for phones that could never run the models themselves.
        </p>
        <p className="settings-hint">
          This cache is keyed only by the public video id. It carries <strong>no personal data</strong>, isn't
          linked to who loaded a track, and never contains anyone's credentials. The audio bytes are already
          reachable by anyone who knows the public video id; the cache just avoids re-fetching and re-computing.
        </p>
      </details>

      <details className="policy">
        <summary>Terms &amp; legal</summary>
        <ul className="info-list">
          <li>
            htl is an open-source tool for live mixing and for music-information research (tempo / key / stem
            analysis). The full source is public on GitHub.
          </li>
          <li>
            Loading content is subject to YouTube's Terms of Service. <strong>You are responsible for what you
            load</strong> and for holding the rights to use it. It's intended for material you own, that's
            cleared, or that's otherwise non-infringing.
          </li>
          <li>
            Stems and analysis are machine-derived from the source audio and provided as-is, for study and
            personal mixing — not as a licensed distribution of the underlying recordings.
          </li>
          <li>
            Provided “as is”, without warranty of any kind. Use at your own risk.
          </li>
          <li>
            A rights holder who wants a track removed from the shared cache can{" "}
            <a href="https://github.com/asuramaya/handlingtheloop/issues" target="_blank" rel="noreferrer noopener">
              open a request on GitHub
            </a>{" "}
            and it will be purged.
          </li>
        </ul>
      </details>

      <h3 className="about-faq-head">FAQ</h3>
      <Faq q="Why do I need to sign in or paste a cookie?">
        YouTube blocks the player API from datacenter IPs (the Worker) with a bot challenge. To load a track that
        isn't already cached, the Worker needs credentials YouTube trusts — your signed-in session.
      </Faq>
      <Faq q="Where are my credentials stored?">
        The <strong>Google account token</strong> stays only in this browser (revoke anytime at Google's
        “Third-party access”). The <strong>streaming cookie</strong> is kept only in memory for this browser
        session — never written to disk, trimmed to the minimum cookies, auto-expiring, gone when you close the
        tab. It's sent only to this site's own Worker, which forwards it to YouTube and never stores, logs, or
        shares it.
      </Faq>
      <Faq q="What does the account see?">
        While connected, YouTube sees those requests as your account, from the Worker's IP. Treat it like signing
        in elsewhere — use an account you're comfortable with, and disconnect to remove it. For zero exposure,
        export cookies while signed out (anonymous) or use a throwaway account.
      </Faq>
      <Faq q="Is the cached audio shared?">
        Yes — audio, stems, and analysis are cached by video id and shared across users so nothing is fetched or
        separated twice. <strong>Your credentials are never part of it.</strong>
      </Faq>

      <div className="info-links">
        <a href="https://handlingtheloop.com" target="_blank" rel="noreferrer noopener">
          handlingtheloop.com
        </a>
        <a href="https://github.com/asuramaya/handlingtheloop" target="_blank" rel="noreferrer noopener">
          GitHub
        </a>
      </div>
    </div>
  );
}
