{ pkgs ? import <nixpkgs> { } }:

pkgs.mkShell {
  packages = with pkgs; [
    nodejs_24 # Runs the server's .ts files directly and builds the web page.
    borgbackup # The backup tool the platform manages.
    (callPackage ./nix/borg2.nix { }) # Borg 2, as borg2, for repositories with borg_version 2.
    git
  ];
}
