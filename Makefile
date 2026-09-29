#      __                      __  ___
#     / /   ____  ____  ____ _/  |/  /_  ____ ___  ____  _______  __
#    / /   / __ \/ __ \/ __ `/ /|_/ / _ \/ __ `__ \/ __ \/ ___/ / / /
#   / /___/ /_/ / / / / /_/ / /  / /  __/ / / / / / /_/ / /  / /_/ /
#  /_____/\____/_/ /_/\__, /_/  /_/\___/_/ /_/ /_/\____/_/   \__, /
#                      /____/                                 /____/
#
#  file  : Makefile
#  usage : supports LongMemory local development

.PHONY: help install build typecheck clean

help:
	@echo "LongMemory local development"
	@echo "  make install     Install dependencies"
	@echo "  make build       Compile TypeScript to dist/"
	@echo "  make typecheck   Run TypeScript type check"
	@echo "  make clean       Remove build artifacts"

install:
	pnpm install

build:
	pnpm build

typecheck:
	pnpm typecheck

clean:
	rm -rf dist
