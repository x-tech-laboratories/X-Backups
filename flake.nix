{
  description = "X-Backups — a web platform for managing borg backups";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        packages.default = pkgs.callPackage ./nix/package.nix { };
        packages.agent = pkgs.callPackage ./nix/agent-package.nix { };
        packages.borg2 = pkgs.callPackage ./nix/borg2.nix { };
        devShells.default = import ./shell.nix { inherit pkgs; };
      }
    ) // {
      nixosModules.default = import ./nix/module.nix self;
      nixosModules.agent = import ./nix/agent-module.nix self;
    };
}
