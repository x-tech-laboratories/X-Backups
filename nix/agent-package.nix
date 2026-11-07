{
  lib,
  buildNpmPackage,
  nodejs_24,
  makeWrapper,
}:

buildNpmPackage {
  pname = "x-backups-agent";
  version = (lib.importJSON ../package.json).version;

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../package-lock.json
      ../src/agent
      ../src/shared
    ];
  };

  nodejs = nodejs_24;
  npmDepsHash = import ./npm-deps-hash.nix;

  nativeBuildInputs = [ makeWrapper ];

  # The agent runs its .ts files as they are, so there is nothing to build.
  dontNpmBuild = true;

  # Node will not run .ts files from under a node_modules folder, so the agent lives in lib/x-backups-agent.
  installPhase = ''
    runHook preInstall

    npm prune --omit=dev --no-save

    mkdir -p $out/lib/x-backups-agent/src
    cp -r package.json node_modules $out/lib/x-backups-agent/
    cp -r src/agent src/shared $out/lib/x-backups-agent/src/

    makeWrapper ${lib.getExe nodejs_24} $out/bin/x-backups-agent \
      --add-flags $out/lib/x-backups-agent/src/agent/main.ts

    runHook postInstall
  '';

  meta = {
    description = "The X-Backups agent, which runs borg on a host for the X-Backups server";
    license = lib.licenses.gpl3Plus;
    mainProgram = "x-backups-agent";
  };
}
