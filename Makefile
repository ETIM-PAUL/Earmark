# make demo: run Earmark locally with nothing real behind it.
# A simulated VTpass, a local stand-in for the receipts contract, a fixed
# naira rate and a rule-based reader instead of the NEAR AI model. No keys,
# no network, no money; .env is never read.

.PHONY: demo test check

NODE_MAJOR := $(shell node -p "process.versions.node.split(\".\")[0]" 2>/dev/null)

demo:
	@test "$(NODE_MAJOR)" -ge 24 || { echo "Node 24 or newer is needed (nvm use). Found: $$(node -v 2>/dev/null || echo none)"; exit 1; }
	@command -v pnpm >/dev/null || { echo "pnpm is needed: corepack enable"; exit 1; }
	pnpm install --frozen-lockfile
	pnpm --filter @earmark/bot... build
	@node bot/dist/local.js & BOT=$$!; \
	pnpm --filter @earmark/sender-web exec vite --host 127.0.0.1 --port 5173 --strictPort --logLevel warn & WEB=$$!; \
	trap "kill $$BOT $$WEB 2>/dev/null" INT TERM EXIT; \
	wait $$BOT

# Everything CI runs for TypeScript, plus the failure drills and the secrets audit.
check:
	pnpm install --frozen-lockfile
	pnpm lint
	pnpm audit:secrets
	pnpm build:ts
	pnpm test:ts

test:
	pnpm test:ts
