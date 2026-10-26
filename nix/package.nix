{
  lib,
  buildNpmPackage,
  nodejs_24,
  makeWrapper,
}:

buildNpmPackage {
  pname = "x-backups";
  version = (lib.importJSON ../package.json).version;

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../package-lock.json
      ../tsconfig.json
      ../tsconfig.server.json
      ../tsconfig.web.json
      ../vite.config.ts
      ../server
      ../web
    ];
  };

  nodejs = nodejs_24;
  npmDepsHash = "sha256-P98HEglsnmZ+z+DPOueLt7JSJjhYt9j0IIr9M4hYwWM=";

  nativeBuildInputs = [ makeWrapper ];

  # Node will not run .ts files from under a node_modules folder, so the app lives in lib/x-backups.
  installPhase = ''
    runHook preInstall

    npm prune --omit=dev --no-save
    find server -name '*.test.ts' -delete
    rm server/borg/testing.ts

    mkdir -p $out/lib/x-backups
    cp -r package.json server dist node_modules $out/lib/x-backups/

    makeWrapper ${lib.getExe nodejs_24} $out/bin/x-backups \
      --add-flags $out/lib/x-backups/server/main.ts \
      --set-default NODE_ENV production

    runHook postInstall
  '';

  meta = {
    description = "A web platform for managing borg backups";
    license = lib.licenses.gpl3Plus;
    mainProgram = "x-backups";
  };
}
