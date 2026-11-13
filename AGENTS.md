# Instructions for AI agents

## X-Tech standards

- Follow the [Application Standard](https://x-tech-laboratories.github.io/standards/application/) and the
  [Design Guidelines](https://x-tech-laboratories.github.io/standards/design/), whose source is `src/content/docs/standards/`
  in [x-tech-laboratories.github.io](https://github.com/x-tech-laboratories/x-tech-laboratories.github.io). Ask before
  changing either, since a change applies to every X-app.
- Use [X-Libs](https://github.com/x-tech-laboratories/X-Libs) and Halon ([X-Themes](https://github.com/x-tech-laboratories/X-Themes))
  before writing your own code: check the module table in the X-Libs README first.
- A feature another app could use belongs in X-Libs, or Halon for styling, with tests and a README row. If that is out
  of reach, add it to the candidates in X-Libs' `docs/TODO.md`.

## Documentation

The `docs/` folder is the GitHub Pages site at <https://x-tech-laboratories.github.io/X-Backups/>, built by Jekyll with
the just-the-docs theme straight from `main`; every page needs its front matter.

- Every commit adds its own line to `docs/changelog.md` under **Unreleased**, beneath a heading for the day it was
  made (newest first), in the words of its commit subject.
- `docs/architecture.md` describes what exists now. `docs/roadmap.md` lists what is not built yet. When an item ships,
  the same commit removes it from the roadmap and describes it in the architecture.
- A change people notice when running or using X-Backups updates the matching page under `docs/user/`.
