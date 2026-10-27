# Borg 2, installed as `borg2` so it sits beside borg 1 on one PATH.

{
  lib,
  stdenv,
  acl,
  fetchPypi,
  lz4,
  openssh,
  openssl,
  python3,
  xxhash,
  zstd,
}:

let
  python = python3;

  borgstore = python.pkgs.buildPythonPackage rec {
    pname = "borgstore";
    version = "0.7.0";
    pyproject = true;
    src = fetchPypi {
      inherit pname version;
      hash = "sha256-EFV+eF65t9ZwngaV7FThooHLc0SVRKlCAuVHw3kFd1w=";
    };
    build-system = with python.pkgs; [
      setuptools
      setuptools-scm
    ];
    dependencies = with python.pkgs; [
      blake3
      requests
    ];
    pythonImportsCheck = [ "borgstore" ];
  };

  borghash = python.pkgs.buildPythonPackage rec {
    pname = "borghash";
    version = "0.2.1";
    pyproject = true;
    src = fetchPypi {
      inherit pname version;
      hash = "sha256-lH9Aqm9k3P9O15R5WDdCi7pf6/vNyLdho+oA1+1El/o=";
    };
    build-system = with python.pkgs; [
      cython
      setuptools
      setuptools-scm
      wheel
    ];
    pythonImportsCheck = [ "borghash" ];
  };
in
python.pkgs.buildPythonApplication rec {
  pname = "borgbackup";
  version = "2.0.0b25";
  pyproject = true;

  src = fetchPypi {
    inherit pname version;
    hash = "sha256-A42O0gKZP+lHfhDtWCwPw6m+ManwkDD/HL6VDNazq7Y=";
  };

  build-system = with python.pkgs; [
    cython
    pkgconfig
    setuptools
    setuptools-scm
    wheel
  ];

  buildInputs = [
    lz4
    openssl
    xxhash
    zstd
  ]
  ++ lib.optionals stdenv.hostPlatform.isLinux [ acl ];

  dependencies = with python.pkgs; [
    blake3
    borghash
    borgstore
    jsonargparse
    msgpack
    packaging
    platformdirs
    pyyaml
    shtab
  ];

  # A beta's own test suite takes long and tests borg rather than how X-Backups calls it.
  doCheck = false;

  makeWrapperArgs = [
    "--prefix"
    "PATH"
    ":"
    "${openssh}/bin"
  ];

  postInstall = ''
    mv $out/bin/borg $out/bin/borg2
    rm -f $out/bin/borgfs
  '';

  meta = {
    description = "Deduplicating archiver with compression and encryption, version 2";
    homepage = "https://www.borgbackup.org";
    license = lib.licenses.bsd3;
    mainProgram = "borg2";
  };
}
