<div align="center">
  <h1>OPAL</h1>
  <p><strong>Every version, in its place.</strong></p>
  <p>A local listening room for the songs, alternate takes, notes, and moments behind a record.</p>
  <p><sub>Early alpha &nbsp;·&nbsp; macOS &nbsp;·&nbsp; Windows x64</sub></p>
</div>

---

OPAL is a local-first music workspace. Gather a project’s tracks, keep alternate versions beside each song, leave notes where they matter, and shape a sequence for a focused listen.

## In OPAL

- **Projects** keep the songs for a record or listening session together.
- **Versions** keep alternate mixes organized beside their track.
- **Notes and moments** capture feedback against a project, take, or point in the audio.
- **Sequences and capsules** let you arrange a listen and save a local reference to it.

## Try the alpha

Installers and build notes are on the [Releases page](https://github.com/SaifMalik0162/OPAL/releases). Check each release for its tested platform and known limits.

OPAL is early software. Use a disposable library while testing and keep a separate backup of anything you import. Your audio, artwork, notes, and library stay on your device. Capsules are local references; they are not remote sharing, and their contents are not encrypted.

## Run from source

You’ll need Node.js 22, Rust, and the native dependencies for [Tauri](https://v2.tauri.app/start/prerequisites/).

```sh
cd opal-prototype
npm ci
npm run tauri:dev
```

Run the full repository verification with:

```sh
npm run verify
```

## Project terms

OPAL is proprietary. Public access allows GitHub’s platform-level viewing and forking; it does not grant general rights to reuse, modify, or redistribute OPAL. See [`LICENSE`](LICENSE). Third-party dependencies and assets keep their own terms.

Code contributions are not open at this stage. Bug reports are welcome through Issues; report security problems privately as described in [`SECURITY.md`](SECURITY.md). Please don’t post audio, private notes, library backups, credentials, or unreviewed diagnostics in public.
