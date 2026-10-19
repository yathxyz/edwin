{
  description = "Edwin: an Emacs-like editor with Evil keys and Org, scripted in its own Scheme, and edwind, its text daemon";

  inputs.nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
      edwind = pkgs.callPackage ./nix/edwind.nix { };
      # Edwin on the desktop: edwin (terminal and window), edwin --daemon and edwind (nix/edwin.nix).
      edwin = pkgs.callPackage ./nix/edwin.nix { inherit edwind; };
      # The frame runtime a web page serves (nix/web.nix): Workbench serves it at /edwin/.
      edwin-web = pkgs.callPackage ./nix/web.nix { };
    in
    {
      packages.${system} = {
        default = edwin;
        inherit edwin edwind edwin-web;
      };

      # nix run .#edwin -- FILE (-g for a window, --daemon for the user's edwind); nix run .#edwind -- --config F.
      apps.${system} = {
        edwin = {
          type = "app";
          program = "${edwin}/bin/edwin";
        };
        edwind = {
          type = "app";
          program = "${edwind}/bin/edwind";
        };
      };

      # programs.edwin: the edwin package, edwind as a user service, EDITOR=edwin (nix/edwin-module.nix).
      nixosModules.edwin = import ./nix/edwin-module.nix self;
      nixosModules.default = self.nixosModules.edwin;

      checks.${system} = import ./nix/checks.nix { inherit pkgs self; };

      devShells.${system}.default = pkgs.mkShell {
        inputsFrom = [ edwin ];
        packages = with pkgs; [
          clippy
          rustfmt
        ];
      };
    };
}
