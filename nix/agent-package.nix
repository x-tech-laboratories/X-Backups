{
  lib,
  stdenvNoCC,
  nodejs_24,
  makeWrapper,
}:

# The agent needs only Node's own modules, so it is just its sources and a wrapper.
stdenvNoCC.mkDerivation {
  pname = "x-backups-agent";
  version = (lib.importJSON ../package.json).version;

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../src/agent
      ../src/shared
    ];
  };

  nativeBuildInputs = [ makeWrapper ];

  installPhase = ''
    runHook preInstall

    mkdir -p $out/lib/x-backups-agent/src
    cp package.json $out/lib/x-backups-agent/
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
